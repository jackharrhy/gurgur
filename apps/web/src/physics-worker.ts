/// <reference lib="webworker" />

import {
  MAX_CATCH_UP_TICKS,
  PHYSICS_DT,
  PHYSICS_SUBSTEPS,
  PROTOCOL_VERSION,
  NETWORK_FLAG_AWAKE,
  NETWORK_FLAG_ACTIVE,
  NETWORK_FLAG_HELD,
  NETWORK_FLAG_REVERSED,
  PhysicsWorld,
  isNewerSequence16,
  type InputCommand,
  type LifecycleMessage,
  type ManipulationChangedMessage,
  type ManipulationDropMessage,
  type ManipulationRequestMessage,
  type ManipulationStatePacket,
  type NetworkBodyState,
  type NetworkObjectState,
  type NetworkPlayerState,
  type OwnershipChangedPacket,
  type OwnershipRequestMessage,
  type RuntimeEntityRef,
  type RuntimeId,
  type PhysicsStepEvents,
} from "@gurgur/engine";
import {
  PLAYER_CAPSULE_HALF_SEGMENT,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_CROUCHED_HALF_SEGMENT,
  PLAYER_GRAB_REACH,
  createPropGrab,
  createHostManipulationTarget,
  grabDistanceFor,
  playerChest,
  playerViewDirection,
  stepHostManipulationTarget,
  stepPlayerController,
  stepPropGrab,
  type GameEngine,
  type HostManipulationTarget,
  type PlayerControllerState,
  type PropGrab,
  type WorldBundle,
  type WorldMessage,
} from "@gurgur/game";
import type { PhysicsWorkerRequest, PhysicsWorkerResponse } from "./ownership-client";

type LocalBody = {
  networkId: RuntimeId;
  handle: RuntimeId;
  entityIndex: number;
  state: NetworkBodyState;
};

type RemotePlayer = {
  networkId: RuntimeId;
  handle: RuntimeId;
  crouched: boolean;
};

type LocalGravityField = {
  entityIndex: number;
  handle: RuntimeId;
  factor: number;
  priority: number;
  visitors: Map<string, number>;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;
let physics: PhysicsWorld | null = null;
let bundle: WorldBundle | null = null;
let worldEpoch = 0;
let localPlayerId: RuntimeId | null = null;
let localPlayer: NetworkPlayerState | null = null;
let localPlayerProxy: RuntimeId | null = null;
let input: InputCommand | null = null;
let lastPrimaryCounter = 0;
let bodies = new Map<string, LocalBody>();
let localToNetwork = new Map<string, RuntimeId>();
let remotePlayers = new Map<string, RemotePlayer>();
let gravityFields: LocalGravityField[] = [];
let localGravityFactor = 1;
let descriptors = new Map<string, RuntimeEntityRef>();
let held: { grab: PropGrab; body: LocalBody; requestId: number } | null = null;
let manipulation: {
  target: HostManipulationTarget;
  authorityVersion: number;
  claimVersion: number;
  stateSequence: number;
} | null = null;
let pendingGrab = new Map<
  number,
  { target: RuntimeId; holdDistance: number; relativeRotation: NetworkBodyState["rotation"] }
>();
let pendingManipulation = new Map<
  number,
  { target: RuntimeId; targetState: HostManipulationTarget; authorityVersion: number }
>();
let nextOwnershipRequestId = 1;
let accumulator = 0;
let lastTimeMs = performance.now();
let timer: number | null = null;
let worldBarrier = Promise.resolve();
let respawnPosition = { x: 0, y: 0, z: 0 };
let respawnYaw = 0;
let voidY = -10_000;

scope.addEventListener("message", (event: MessageEvent<PhysicsWorkerRequest>) => {
  const message = event.data;
  if (message.type === "world") {
    worldBarrier = setWorld(message.world, message.states, message.localPlayerId).catch(report);
  } else if (message.type === "input") {
    input = message.command;
    void worldBarrier.then(processInputEdges);
  } else if (message.type === "network-states") {
    void worldBarrier.then(() => applyNetworkStates(message.states));
  } else if (message.type === "lifecycle") {
    void worldBarrier.then(() => applyLifecycle(message.message));
  } else if (message.type === "ownership-changed") {
    void worldBarrier.then(() => applyOwnership(message.message));
  } else if (message.type === "ownership-denied") {
    pendingGrab.delete(message.message.requestId);
  } else if (message.type === "manipulation-changed") {
    void worldBarrier.then(() => applyManipulation(message.message));
  } else {
    pendingManipulation.delete(message.message.requestId);
  }
});

async function setWorld(
  message: WorldMessage,
  states: NetworkObjectState[],
  playerId: RuntimeId,
): Promise<void> {
  if (timer !== null) clearInterval(timer);
  timer = null;
  physics?.dispose();
  physics = await PhysicsWorld.create({
    locateFile: () => "/box3d.wasm",
    gravity: message.bundle.settings.gravity,
  });
  bundle = message.bundle;
  worldEpoch = message.worldEpoch;
  localPlayerId = { ...playerId };
  localPlayer = null;
  localPlayerProxy = null;
  bodies = new Map();
  localToNetwork = new Map();
  remotePlayers = new Map();
  gravityFields = [];
  localGravityFactor = 1;
  descriptors = new Map(message.runtimeEntities.map((entity) => [key(entity.id), entity]));
  held = null;
  manipulation = null;
  pendingGrab.clear();
  pendingManipulation.clear();
  input = null;
  lastPrimaryCounter = 0;
  accumulator = 0;
  lastTimeMs = performance.now();
  const spawn = message.bundle.playerSpawns.find((candidate) => candidate.name === "default");
  if (!spawn) throw new Error("world is missing the default player spawn");
  respawnPosition = {
    x: spawn.position.x,
    y: spawn.position.y + PLAYER_CAPSULE_RADIUS + PLAYER_CAPSULE_HALF_SEGMENT,
    z: spawn.position.z,
  };
  respawnYaw = spawn.yaw;
  voidY = Math.min(...message.bundle.staticCollision.vertices.map((vertex) => vertex.y)) - 10;

  physics.createStaticMesh({
    vertices: message.bundle.staticCollision.vertices,
    triangles: message.bundle.staticCollision.triangles,
  });
  const stateById = new Map(states.map((state) => [key(state.id), state]));
  for (const descriptor of message.runtimeEntities) {
    const state = stateById.get(key(descriptor.id));
    if (!state) continue;
    if (descriptor.kind === "player" && state.kind === "player") {
      if (sameId(descriptor.id, playerId)) {
        localPlayer = clonePlayer(state);
        localPlayerProxy = physics.createPlayerProxy(state.position, playerCapsule(state.crouched));
      } else {
        const handle = physics.createPlayerProxy(state.position, playerCapsule(state.crouched));
        remotePlayers.set(key(descriptor.id), {
          networkId: { ...descriptor.id },
          handle,
          crouched: state.crouched,
        });
      }
      continue;
    }
    if (descriptor.kind !== "world-entity" || state.kind !== "body") continue;
    const body = createBody(physics, message.bundle, descriptor, state);
    if (!body) continue;
    bodies.set(key(descriptor.id), body);
    localToNetwork.set(key(body.handle), { ...descriptor.id });
    const entity = message.bundle.entities[descriptor.entityIndex];
    if (entity?.kind === "gravity-field")
      gravityFields.push({
        entityIndex: descriptor.entityIndex,
        handle: body.handle,
        factor: entity.factor,
        priority: entity.priority,
        visitors: new Map(),
      });
  }
  if (!localPlayer) throw new Error("world bootstrap is missing the local player");
  timer = scope.setInterval(tick, 4);
  post({ type: "world-ready", worldEpoch });
}

function tick(): void {
  if (!physics || !bundle || !localPlayer || !input || input.worldEpoch !== worldEpoch) {
    lastTimeMs = performance.now();
    return;
  }
  const now = performance.now();
  accumulator = Math.min(accumulator + Math.max(0, (now - lastTimeMs) / 1_000), PHYSICS_DT * 4);
  lastTimeMs = now;
  let steps = 0;
  while (accumulator >= PHYSICS_DT && steps < MAX_CATCH_UP_TICKS) {
    const controller: PlayerControllerState = {
      position: { ...localPlayer.position },
      yaw: localPlayer.yaw,
      verticalVelocity: localPlayer.verticalVelocity,
      grounded: localPlayer.grounded,
      crouched: localPlayer.crouched,
      lastJumpCounter: localPlayer.lastJumpCounter,
      stepCooldown: localPlayer.stepCooldown,
    };
    let next = stepPlayerController(
      physics,
      controller,
      input,
      PHYSICS_DT,
      Math.max(0, -bundle.settings.gravity.y) * localGravityFactor,
    );
    let respawned = false;
    if (next.position.y < voidY) {
      next = {
        position: { ...respawnPosition },
        yaw: respawnYaw,
        verticalVelocity: 0,
        grounded: false,
        crouched: false,
        lastJumpCounter: input.jumpCounter,
        stepCooldown: 0,
      };
      respawned = true;
      if (held) dropHeld();
      if (manipulation) dropManipulation();
    }
    if (localPlayerProxy && next.crouched !== localPlayer.crouched) {
      clearGravityVisitor(localPlayerProxy);
      physics.destroy(localPlayerProxy);
      localPlayerProxy = physics.createPlayerProxy(next.position, playerCapsule(next.crouched));
    } else if (localPlayerProxy) {
      physics.setBodyTransform(localPlayerProxy, next.position, yawRotation(next.yaw));
    }
    localPlayer = {
      ...localPlayer,
      stateSequence: (localPlayer.stateSequence + 1) & 0xffff,
      position: { ...next.position },
      rotation: yawRotation(next.yaw),
      linearVelocity: { x: 0, y: next.verticalVelocity, z: 0 },
      yaw: next.yaw,
      verticalVelocity: next.verticalVelocity,
      grounded: next.grounded,
      crouched: next.crouched,
      lastJumpCounter: next.lastJumpCounter,
      stepCooldown: next.stepCooldown,
    };
    if (respawned) post({ type: "owner-commit", states: [clonePlayer(localPlayer)] });
    if (held) {
      const alive = stepPropGrab(physicsEngine(), held.grab, {
        position: localPlayer.position,
        yaw: localPlayer.yaw,
        lookYaw: input.lookYaw,
        lookPitch: input.lookPitch,
      });
      if (!alive) dropHeld();
    }
    if (manipulation)
      stepHostManipulationTarget(physicsEngine(), manipulation.target, playerPose());
    const events = physics.step(PHYSICS_DT, PHYSICS_SUBSTEPS);
    processGravityEvents(events);
    if (held) held.body.state = readBodyState(held.body);
    accumulator -= PHYSICS_DT;
    steps += 1;
  }
  if (steps === 0) return;
  const localStates: NetworkObjectState[] = [
    clonePlayer(localPlayer),
    ...(held ? [cloneBody(held.body.state)] : []),
  ];
  post({
    type: "local-states",
    states: localStates,
    producedAtMs: now,
  });
  if ((localPlayer.stateSequence & 1) === 0) {
    post({ type: "owner-states", states: localStates });
    if (manipulation) {
      manipulation.stateSequence = (manipulation.stateSequence + 1) & 0xffff;
      const message: ManipulationStatePacket = {
        worldEpoch,
        target: { ...manipulation.target.target },
        authorityVersion: manipulation.authorityVersion,
        claimVersion: manipulation.claimVersion,
        stateSequence: manipulation.stateSequence,
        targetPosition: { ...manipulation.target.targetPosition },
        targetRotation: { ...manipulation.target.targetRotation },
      };
      post({ type: "manipulation-state", message });
    }
  }
}

function processInputEdges(): void {
  if (!input || !localPlayer) return;
  if (input.primaryCounter === lastPrimaryCounter) return;
  lastPrimaryCounter = input.primaryCounter;
  if (held) {
    dropHeld();
    return;
  }
  if (manipulation) {
    dropManipulation();
    return;
  }
  if (!input.interactTarget || !physics || !bundle) return;
  const target = bodies.get(key(input.interactTarget));
  const descriptor = descriptors.get(key(input.interactTarget));
  if (!target || !descriptor || descriptor.kind !== "world-entity") return;
  const entity = bundle.entities[descriptor.entityIndex];
  if (
    descriptor.transferPolicy === "fixed" &&
    descriptor.ownerPlayerId === null &&
    entity?.kind === "physics-prop" &&
    entity.interaction === "manipulate"
  ) {
    const origin = playerChest(localPlayer.position);
    const direction = playerViewDirection(input.lookYaw, input.lookPitch);
    const hit = physics.raycastClosest(origin, scale(direction, PLAYER_GRAB_REACH), {
      ignoreBodies: localPlayerProxy ? [localPlayerProxy] : [],
    });
    const hitTarget = hit ? localToNetwork.get(key(hit.body)) : null;
    if (!hit || !hitTarget || !sameId(hitTarget, target.networkId)) return;
    const localAnchor = inverseRotate(
      target.state.rotation,
      subtract(hit.point, target.state.position),
    );
    const holdDistance = Math.hypot(
      hit.point.x - origin.x,
      hit.point.y - origin.y,
      hit.point.z - origin.z,
    );
    const requestId = nextOwnershipRequestId++;
    const targetState = createHostManipulationTarget(
      physicsEngine(),
      target.networkId,
      localAnchor,
      playerPose(),
      holdDistance,
    );
    pendingManipulation.set(requestId, {
      target: { ...target.networkId },
      targetState,
      authorityVersion: target.state.authorityVersion,
    });
    const message: ManipulationRequestMessage = {
      type: "manipulation-request",
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch,
      requestId,
      target: { ...target.networkId },
      authorityVersion: target.state.authorityVersion,
      localAnchor,
      holdDistance,
    };
    post({ type: "manipulation-request", message });
    return;
  }
  if (descriptor.transferPolicy !== "grab-lease" || descriptor.ownerPlayerId !== null) return;
  const requestId = nextOwnershipRequestId++;
  const holdDistance = grabDistanceFor(bundle, descriptor.entityIndex);
  const grab = createPropGrab(physicsEngine(), target.networkId, playerPose(), holdDistance);
  pendingGrab.set(requestId, {
    target: { ...target.networkId },
    holdDistance,
    relativeRotation: { ...grab.relativeRotation },
  });
  const message: OwnershipRequestMessage = {
    type: "ownership-request",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch,
    requestId,
    target: { ...target.networkId },
    authorityVersion: target.state.authorityVersion,
    holdDistance,
    relativeRotation: { ...grab.relativeRotation },
  };
  post({ type: "ownership-request", message });
}

function applyNetworkStates(states: NetworkObjectState[]): void {
  if (!physics || !localPlayerId) return;
  for (const state of states) {
    if (sameId(state.id, localPlayerId)) continue;
    const descriptor = descriptors.get(key(state.id));
    if (descriptor?.ownerPlayerId && sameId(descriptor.ownerPlayerId, localPlayerId)) continue;
    if (state.kind === "player") {
      updateRemotePlayer(state);
      continue;
    }
    const body = bodies.get(key(state.id));
    if (!body) {
      if (!bundle || descriptor?.kind !== "world-entity") continue;
      const created = createBody(physics, bundle, descriptor, state);
      if (!created) continue;
      bodies.set(key(state.id), created);
      localToNetwork.set(key(created.handle), { ...state.id });
      continue;
    }
    if (state.authorityVersion < body.state.authorityVersion) continue;
    body.state = cloneBody(state);
    physics.setBodyTransform(body.handle, state.position, state.rotation);
    physics.setBodyVelocity(body.handle, state.linearVelocity, state.angularVelocity);
    if (bundle && descriptor?.kind === "world-entity")
      applySurfaceMotor(physics, bundle, descriptor.entityIndex, body.handle, state.flags);
  }
}

function applyOwnership(message: OwnershipChangedPacket): void {
  if (!physics || !localPlayerId || message.worldEpoch !== worldEpoch) return;
  const descriptor = descriptors.get(key(message.id));
  if (descriptor) {
    descriptor.ownerPlayerId = message.ownerPlayerId ? { ...message.ownerPlayerId } : null;
    descriptor.authorityVersion = message.authorityVersion;
  }
  if (message.state.kind === "player" && sameId(message.id, localPlayerId)) {
    if (
      localPlayer &&
      message.state.authorityVersion === localPlayer.authorityVersion &&
      message.state.stateSequence !== localPlayer.stateSequence &&
      !isNewerSequence16(message.state.stateSequence, localPlayer.stateSequence)
    )
      return;
    localPlayer = clonePlayer(message.state);
    return;
  }
  if (message.state.kind === "player") {
    updateRemotePlayer(message.state);
    return;
  }
  if (message.state.kind !== "body") return;
  let body = bodies.get(key(message.id));
  if (!body && bundle && descriptor?.kind === "world-entity") {
    body = createBody(physics, bundle, descriptor, message.state) ?? undefined;
    if (body) {
      bodies.set(key(message.id), body);
      localToNetwork.set(key(body.handle), { ...message.id });
    }
  }
  if (!body) return;
  body.state = cloneBody(message.state);
  physics.setBodyTransform(body.handle, message.state.position, message.state.rotation);
  physics.setBodyVelocity(body.handle, message.state.linearVelocity, message.state.angularVelocity);
  if (bundle && descriptor?.kind === "world-entity")
    applySurfaceMotor(physics, bundle, descriptor.entityIndex, body.handle, message.state.flags);
  const localOwner = message.ownerPlayerId && sameId(message.ownerPlayerId, localPlayerId);
  if (localOwner) {
    const pending = message.requestId === null ? null : pendingGrab.get(message.requestId);
    if (!pending || !sameId(pending.target, body.networkId)) return;
    physics.setBodyType(body.handle, "dynamic");
    applyGravityToBody(body);
    const grab = createPropGrab(
      physicsEngine(),
      body.networkId,
      playerPose(),
      pending.holdDistance,
    );
    grab.relativeRotation = { ...pending.relativeRotation };
    held = {
      body,
      requestId: message.requestId!,
      grab,
    };
    pendingGrab.delete(message.requestId!);
  } else {
    physics.setBodyType(body.handle, "kinematic");
    if (held && sameId(held.body.networkId, body.networkId)) held = null;
  }
}

function applyManipulation(message: ManipulationChangedMessage): void {
  if (!localPlayerId || message.worldEpoch !== worldEpoch) return;
  const localManipulator =
    message.manipulatorPlayerId !== null && sameId(message.manipulatorPlayerId, localPlayerId);
  if (localManipulator && message.requestId !== null) {
    const pending = pendingManipulation.get(message.requestId);
    if (
      pending &&
      sameId(pending.target, message.target) &&
      pending.authorityVersion === message.authorityVersion
    ) {
      manipulation = {
        target: pending.targetState,
        authorityVersion: message.authorityVersion,
        claimVersion: message.claimVersion,
        stateSequence: 0,
      };
      pendingManipulation.delete(message.requestId);
    }
    return;
  }
  if (manipulation && sameId(manipulation.target.target, message.target)) manipulation = null;
  for (const [requestId, pending] of pendingManipulation)
    if (sameId(pending.target, message.target)) pendingManipulation.delete(requestId);
}

function applyLifecycle(message: LifecycleMessage): void {
  if (!physics || message.worldEpoch !== worldEpoch) return;
  for (const id of message.removed) {
    const identity = key(id);
    const body = bodies.get(identity);
    if (body) {
      physics.destroy(body.handle);
      gravityFields = gravityFields.filter((field) => !sameId(field.handle, body.handle));
      localToNetwork.delete(key(body.handle));
      bodies.delete(identity);
    }
    const remote = remotePlayers.get(identity);
    if (remote) {
      physics.destroy(remote.handle);
      remotePlayers.delete(identity);
    }
    descriptors.delete(identity);
    pendingGrab.forEach((pending, requestId) => {
      if (sameId(pending.target, id)) pendingGrab.delete(requestId);
    });
    pendingManipulation.forEach((pending, requestId) => {
      if (sameId(pending.target, id)) pendingManipulation.delete(requestId);
    });
    if (held && sameId(held.body.networkId, id)) held = null;
    if (manipulation && sameId(manipulation.target.target, id)) manipulation = null;
  }
  for (const descriptor of message.created)
    descriptors.set(key(descriptor.id), structuredClone(descriptor));
}

function dropHeld(): void {
  if (!held) return;
  held.body.state = readBodyState(held.body);
  const message = {
    worldEpoch,
    id: { ...held.body.networkId },
    authorityVersion: held.body.state.authorityVersion,
    state: cloneBody(held.body.state),
  };
  physics?.setBodyType(held.body.handle, "kinematic");
  held = null;
  post({ type: "ownership-drop", message });
}

function dropManipulation(): void {
  if (!manipulation) return;
  const message: ManipulationDropMessage = {
    type: "manipulation-drop",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch,
    target: { ...manipulation.target.target },
    authorityVersion: manipulation.authorityVersion,
    claimVersion: manipulation.claimVersion,
  };
  manipulation = null;
  post({ type: "manipulation-drop", message });
}

function updateRemotePlayer(state: NetworkPlayerState): void {
  if (!physics) return;
  const identity = key(state.id);
  let remote = remotePlayers.get(identity);
  if (!remote || remote.crouched !== state.crouched) {
    if (remote) physics.destroy(remote.handle);
    remote = {
      networkId: { ...state.id },
      handle: physics.createPlayerProxy(state.position, playerCapsule(state.crouched)),
      crouched: state.crouched,
    };
    remotePlayers.set(identity, remote);
  } else {
    physics.setBodyTransform(remote.handle, state.position, state.rotation);
  }
}

function processGravityEvents(events: PhysicsStepEvents): void {
  for (const event of events.sensorBegin) updateGravityOverlap(event.sensor, event.visitor, true);
  for (const event of events.sensorEnd) updateGravityOverlap(event.sensor, event.visitor, false);
}

function updateGravityOverlap(sensor: RuntimeId, visitor: RuntimeId, entering: boolean): void {
  const field = gravityFields.find((candidate) => sameId(candidate.handle, sensor));
  if (!field) return;
  const visitorKey = key(visitor);
  const previous = field.visitors.get(visitorKey) ?? 0;
  const next = entering ? previous + 1 : Math.max(0, previous - 1);
  if (next === 0) field.visitors.delete(visitorKey);
  else field.visitors.set(visitorKey, next);
  if ((entering && previous === 0) || (!entering && next === 0)) recomputeGravityVisitor(visitor);
}

function clearGravityVisitor(visitor: RuntimeId): void {
  const visitorKey = key(visitor);
  for (const field of gravityFields) field.visitors.delete(visitorKey);
  if (localPlayerProxy && sameId(localPlayerProxy, visitor)) localGravityFactor = 1;
}

function recomputeGravityVisitor(visitor: RuntimeId): void {
  const factor = gravityFactorFor(visitor);
  if (localPlayerProxy && sameId(localPlayerProxy, visitor)) localGravityFactor = factor;
  if (held && sameId(held.body.handle, visitor)) applyGravityToBody(held.body);
}

function gravityFactorFor(visitor: RuntimeId): number {
  const visitorKey = key(visitor);
  return (
    gravityFields
      .filter((field) => (field.visitors.get(visitorKey) ?? 0) > 0)
      .toSorted(
        (left, right) => right.priority - left.priority || left.entityIndex - right.entityIndex,
      )[0]?.factor ?? 1
  );
}

function applyGravityToBody(body: LocalBody): void {
  if (!physics || !bundle) return;
  const entity = bundle.entities[body.entityIndex];
  if (entity?.body?.kind !== "dynamic-brush") return;
  physics.setGravityScale(body.handle, entity.body.gravityScale * gravityFactorFor(body.handle));
}

function applySurfaceMotor(
  world: PhysicsWorld,
  source: WorldBundle,
  entityIndex: number,
  handle: RuntimeId,
  flags: number,
): void {
  const entity = source.entities[entityIndex];
  if (entity?.kind !== "surface-motor") return;
  const active = (flags & NETWORK_FLAG_ACTIVE) !== 0;
  const direction = (flags & NETWORK_FLAG_REVERSED) !== 0 ? -1 : 1;
  world.setSurfaceVelocity(
    handle,
    active
      ? {
          x: entity.velocity.x * direction,
          y: entity.velocity.y * direction,
          z: entity.velocity.z * direction,
        }
      : { x: 0, y: 0, z: 0 },
  );
}

function createBody(
  world: PhysicsWorld,
  source: WorldBundle,
  descriptor: Extract<RuntimeEntityRef, { kind: "world-entity" }>,
  state: NetworkBodyState,
): LocalBody | null {
  const entity = source.entities[descriptor.entityIndex];
  const spec = entity?.body;
  if (!entity || !spec) return null;
  const first = source.brushes[spec.brushIndices[0]!];
  if (!first) return null;
  if (spec.kind === "sensor-brush") {
    if (entity.kind !== "gravity-field") return null;
    const handle = world.createSensorHulls({
      position: state.position,
      rotation: state.rotation,
      hulls: spec.brushIndices.map((index) => ({
        vertices: source.brushes[index]!.worldVertices,
      })),
    });
    return {
      networkId: { ...descriptor.id },
      handle,
      entityIndex: descriptor.entityIndex,
      state: cloneBody(state),
    };
  }
  const type =
    spec.kind === "static-brush"
      ? "static"
      : descriptor.ownerPlayerId && localPlayerId && sameId(descriptor.ownerPlayerId, localPlayerId)
        ? "dynamic"
        : "kinematic";
  const material =
    spec.kind === "dynamic-brush"
      ? {
          density: spec.density,
          friction: spec.friction,
          restitution: spec.restitution,
        }
      : entity.kind === "surface-motor"
        ? { friction: entity.friction }
        : {};
  const handle =
    spec.brushIndices.length === 1
      ? world.createHull({
          type,
          position: state.position,
          rotation: state.rotation,
          vertices: first.localVertices,
          ...material,
        })
      : world.createCompoundHulls({
          type,
          position: state.position,
          rotation: state.rotation,
          hulls: spec.brushIndices.map((index) => ({
            vertices: source.brushes[index]!.worldVertices.map((vertex) => ({
              x: vertex.x - first.center.x,
              y: vertex.y - first.center.y,
              z: vertex.z - first.center.z,
            })),
          })),
          ...material,
        });
  world.setBodyVelocity(handle, state.linearVelocity, state.angularVelocity);
  if (spec.kind === "dynamic-brush") world.setGravityScale(handle, spec.gravityScale);
  applySurfaceMotor(world, source, descriptor.entityIndex, handle, state.flags);
  return {
    networkId: { ...descriptor.id },
    handle,
    entityIndex: descriptor.entityIndex,
    state: cloneBody(state),
  };
}

function physicsEngine(): GameEngine {
  if (!physics) throw new Error("owner physics is unavailable");
  return {
    tick: localPlayer?.stateSequence ?? 0,
    dt: PHYSICS_DT,
    bodies: {
      forEntity: (entityIndex) => {
        const body = [...bodies.values()].find(
          (candidate) => candidate.entityIndex === entityIndex,
        );
        return body ? { id: { ...body.networkId }, entityIndex } : null;
      },
      resolve: (id) => {
        const body = bodies.get(key(id));
        return body ? { id: { ...body.networkId }, entityIndex: body.entityIndex } : null;
      },
      state: (id) => {
        const body = bodies.get(key(id));
        if (!body) throw new Error("network body is unavailable");
        return { ...physics!.state(body.handle), id: { ...id } };
      },
    },
    setKinematicTarget: () => {},
    setBodyAwake: (id, awake) => {
      const body = bodies.get(key(id));
      return body ? physics!.setBodyAwake(body.handle, awake) : false;
    },
    raycast: (origin, displacement, options) => {
      const hit = physics!.raycastClosest(origin, displacement, {
        ignoreBodies: (options?.ignoreBodies ?? []).flatMap((id) => {
          const body = bodies.get(key(id));
          return body ? [body.handle] : [];
        }),
      });
      const networkId = hit ? localToNetwork.get(key(hit.body)) : null;
      if (!hit) return null;
      return {
        ...hit,
        body: networkId ? { ...networkId } : { index: 0xffff_ffff, generation: 0 },
      };
    },
    createPlayerProxy: (position, shape) => physics!.createPlayerProxy(position, shape),
    updatePlayerProxy: (id, position, yaw) =>
      physics!.setBodyTransform(id, position, yawRotation(yaw)),
    destroyBody: (id) => physics!.destroy(id),
    driveBodyToTarget: (id, options) => {
      const body = bodies.get(key(id));
      return body
        ? physics!.driveBodyToTarget(body.handle, { ...options, seconds: PHYSICS_DT })
        : false;
    },
    requestSave: () => {},
  };
}

function readBodyState(body: LocalBody): NetworkBodyState {
  const state = physics!.state(body.handle);
  return {
    kind: "body",
    id: { ...body.networkId },
    authorityVersion: body.state.authorityVersion,
    stateSequence: (body.state.stateSequence + 1) & 0xffff,
    position: { ...state.position },
    rotation: { ...state.rotation },
    linearVelocity: { ...state.linearVelocity },
    angularVelocity: { ...state.angularVelocity },
    flags: NETWORK_FLAG_HELD | (state.awake ? NETWORK_FLAG_AWAKE : 0),
  };
}

function playerPose() {
  return {
    position: localPlayer!.position,
    yaw: localPlayer!.yaw,
    lookYaw: input?.lookYaw ?? localPlayer!.yaw,
    lookPitch: input?.lookPitch ?? 0,
  };
}

function cloneBody(state: NetworkBodyState): NetworkBodyState {
  return {
    ...state,
    id: { ...state.id },
    position: { ...state.position },
    rotation: { ...state.rotation },
    linearVelocity: { ...state.linearVelocity },
    angularVelocity: { ...state.angularVelocity },
  };
}

function clonePlayer(state: NetworkPlayerState): NetworkPlayerState {
  return {
    ...state,
    id: { ...state.id },
    position: { ...state.position },
    rotation: { ...state.rotation },
    linearVelocity: { ...state.linearVelocity },
    angularVelocity: { ...state.angularVelocity },
  };
}

function playerCapsule(crouched: boolean) {
  return {
    radius: PLAYER_CAPSULE_RADIUS,
    halfSegment: crouched ? PLAYER_CROUCHED_HALF_SEGMENT : PLAYER_CAPSULE_HALF_SEGMENT,
  };
}

function yawRotation(yaw: number) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function subtract(a: NetworkBodyState["position"], b: NetworkBodyState["position"]) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(value: NetworkBodyState["position"], amount: number) {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

function inverseRotate(
  rotation: NetworkBodyState["rotation"],
  value: NetworkBodyState["position"],
) {
  const inverse = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w };
  const tx = 2 * (inverse.y * value.z - inverse.z * value.y);
  const ty = 2 * (inverse.z * value.x - inverse.x * value.z);
  const tz = 2 * (inverse.x * value.y - inverse.y * value.x);
  return {
    x: value.x + inverse.w * tx + inverse.y * tz - inverse.z * ty,
    y: value.y + inverse.w * ty + inverse.z * tx - inverse.x * tz,
    z: value.z + inverse.w * tz + inverse.x * ty - inverse.y * tx,
  };
}

function sameId(a: RuntimeId, b: RuntimeId): boolean {
  return a.index === b.index && a.generation === b.generation;
}

function key(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}

function post(message: PhysicsWorkerResponse): void {
  scope.postMessage(message);
}

function report(error: unknown): void {
  post({ type: "error", message: error instanceof Error ? error.message : "owner physics failed" });
}
