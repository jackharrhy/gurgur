/// <reference lib="webworker" />

import {
  MAX_CATCH_UP_TICKS,
  PREDICTION_HISTORY_CAPACITY,
  PHYSICS_DT,
  PHYSICS_SUBSTEPS,
  PROTOCOL_VERSION,
  NETWORK_FLAG_ACTIVE,
  NETWORK_FLAG_AWAKE,
  NETWORK_FLAG_REVERSED,
  NETWORK_FLAG_HELD,
  PhysicsWorld,
  accumulateFixedStepTime,
  isNewerSequence16,
  unwrapTick32,
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
  type RuntimeEntityRef,
  type RuntimeId,
  type PhysicsStepEvents,
  type PredictionCheckpointPacket,
} from "@gurgur/engine";
import {
  PLAYER_CAPSULE_HALF_SEGMENT,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_CROUCHED_HALF_SEGMENT,
  PLAYER_GRAB_REACH,
  createHostManipulationTarget,
  stepPropGrab,
  playerChest,
  playerViewDirection,
  stepHostManipulationTarget,
  stepPlayerController,
  type GameEngine,
  type HostManipulationTarget,
  type PropGrab,
  type PlayerControllerState,
  type WorldBundle,
  type WorldMessage,
} from "@gurgur/game";
import type { PhysicsWorkerRequest, PhysicsWorkerResponse } from "./ownership-client";

type LocalBody = {
  networkId: RuntimeId;
  handle: RuntimeId;
  entityIndex: number;
  state: NetworkBodyState;
  history: NetworkBodyState[];
};

type RemotePlayer = {
  networkId: RuntimeId;
  handle: RuntimeId;
  crouched: boolean;
  state: NetworkPlayerState;
  history: NetworkPlayerState[];
};

type PredictionRecord = {
  command: InputCommand;
  serverTick: number;
  player: NetworkPlayerState;
  held: NetworkBodyState | null;
  proxyTick: number;
};

type LocalGravityField = {
  entityIndex: number;
  handle: RuntimeId;
  factor: number;
  priority: number;
  visitors: Map<string, number>;
};

const TRACE_RADIUS_METRES = 6;
const TRACE_MAX_NEARBY_OBJECTS = 32;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let physics: PhysicsWorld | null = null;
let bundle: WorldBundle | null = null;
let worldEpoch = 0;
let localPlayerId: RuntimeId | null = null;
let localPlayer: NetworkPlayerState | null = null;
let localPlayerProxy: RuntimeId | null = null;
let input: InputCommand | null = null;
let nextInputSequence = 0;
let predictionTick = 0;
let predictionHistory: PredictionRecord[] = [];
let lastAcknowledgedInputSequence = -1;
let lastAcknowledgedPrimaryCounter = 0;
let predictionPrimaryCounter = 0;
let lastPrimaryCounter = 0;
let bodies = new Map<string, LocalBody>();
let localToNetwork = new Map<string, RuntimeId>();
let remotePlayers = new Map<string, RemotePlayer>();
let gravityFields: LocalGravityField[] = [];
let localGravityFactor = 1;
let activePredictionContacts = new Map<string, { id: RuntimeId; count: number }>();
let descriptors = new Map<string, RuntimeEntityRef>();
let manipulation: {
  target: HostManipulationTarget;
  authorityVersion: number;
  claimVersion: number;
  stateSequence: number;
} | null = null;
let predictedGrab: { grab: PropGrab; claimVersion: number } | null = null;
let pendingManipulation = new Map<
  number,
  { target: RuntimeId; targetState: HostManipulationTarget; authorityVersion: number }
>();
let nextManipulationRequestId = 1;
let accumulator = 0;
let discardedCatchUpSeconds = 0;
let lastTimeMs = performance.now();
let timer: number | null = null;
let worldBarrier = Promise.resolve();
let respawnPosition = { x: 0, y: 0, z: 0 };
let respawnYaw = 0;
let voidY = -10_000;
let traceEnabled = false;

scope.addEventListener("message", (event: MessageEvent<PhysicsWorkerRequest>) => {
  const message = event.data;
  if (message.type === "world") {
    worldBarrier = setWorld(
      message.world,
      message.states,
      message.localPlayerId,
      message.traceEnabled,
    ).catch(report);
  } else if (message.type === "input") {
    input = message.command;
    void worldBarrier.then(processInputEdges);
  } else if (message.type === "network-states") {
    void worldBarrier.then(() => applyNetworkStates(message.states));
  } else if (message.type === "checkpoint") {
    void worldBarrier.then(() => applyCheckpoint(message.message));
  } else if (message.type === "lifecycle") {
    void worldBarrier.then(() => applyLifecycle(message.message));
  } else if (message.type === "ownership-changed") {
    void worldBarrier.then(() => applyOwnership(message.message));
  } else if (message.type === "manipulation-changed") {
    void worldBarrier.then(() => applyManipulation(message.message));
  } else if (message.type === "stall-for-test") {
    const durationMs = Math.max(0, Math.min(500, message.durationMs));
    const until = performance.now() + durationMs;
    while (performance.now() < until) {
      // Intentionally occupy this worker to verify fixed-step overload accounting.
    }
  } else {
    pendingManipulation.delete(message.message.requestId);
  }
});

async function setWorld(
  message: WorldMessage,
  states: NetworkObjectState[],
  playerId: RuntimeId,
  enableTrace: boolean,
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
  traceEnabled = enableTrace;
  localPlayerId = { ...playerId };
  localPlayer = null;
  localPlayerProxy = null;
  bodies = new Map();
  localToNetwork = new Map();
  remotePlayers = new Map();
  gravityFields = [];
  localGravityFactor = 1;
  activePredictionContacts = new Map();
  descriptors = new Map(message.runtimeEntities.map((entity) => [key(entity.id), entity]));
  manipulation = null;
  predictedGrab = null;
  pendingManipulation.clear();
  input = null;
  nextInputSequence = 0;
  predictionTick = 0;
  predictionHistory = [];
  lastAcknowledgedInputSequence = -1;
  lastAcknowledgedPrimaryCounter = 0;
  predictionPrimaryCounter = 0;
  lastPrimaryCounter = 0;
  accumulator = 0;
  discardedCatchUpSeconds = 0;
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
          state: clonePlayer(state),
          history: [clonePlayer(state)],
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
  const accumulated = accumulateFixedStepTime(accumulator, (now - lastTimeMs) / 1_000);
  accumulator = accumulated.accumulatorSeconds;
  discardedCatchUpSeconds += accumulated.discardedSeconds;
  lastTimeMs = now;
  let steps = 0;
  while (accumulator >= PHYSICS_DT && steps < MAX_CATCH_UP_TICKS) {
    const command = nextFixedCommand();
    post({ type: "input-command", command });
    simulateCommand(command, localPlayer.sourceTick + 1);
    const result = localPredictedStates();
    predictionHistory.push({
      command: structuredClone(command),
      serverTick: localPlayer.sourceTick,
      player: clonePlayer(localPlayer),
      held: clonePredictedBody(result),
      proxyTick: localPlayer.sourceTick,
    });
    while (predictionHistory.length > PREDICTION_HISTORY_CAPACITY) predictionHistory.shift();
    accumulator -= PHYSICS_DT;
    steps += 1;
  }
  if (steps === 0) return;
  const localStates = localPredictedStates();
  const contacts = predictionContacts();
  const command = predictionHistory.at(-1)?.command ?? null;
  post({
    type: "local-states",
    states: localStates,
    collisionStates: traceEnabled ? clientCollisionStates(contacts) : [],
    producedAtMs: now,
    discardedCatchUpSeconds,
    reconciled: false,
    inputSequence: nextInputSequence - 1,
    acknowledgment: lastAcknowledgedInputSequence < 0 ? null : lastAcknowledgedInputSequence,
    replayCount: 0,
    contactIds: contacts.contactIds,
    supportIds: contacts.supportIds,
    command: command ? structuredClone(command) : null,
  });
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

function nextFixedCommand(): InputCommand {
  const source = input!;
  return {
    ...source,
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch,
    sequence: nextInputSequence++,
    clientTick: predictionTick++,
    interactTarget: source.interactTarget ? { ...source.interactTarget } : null,
  };
}

function simulateCommand(command: InputCommand, serverTick: number): void {
  if (!physics || !bundle || !localPlayer) return;
  applyProxyTargets(serverTick);
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
    command,
    PHYSICS_DT,
    Math.max(0, -bundle.settings.gravity.y) * localGravityFactor,
  );
  if (next.position.y < voidY) {
    next = {
      position: { ...respawnPosition },
      yaw: respawnYaw,
      verticalVelocity: 0,
      grounded: false,
      crouched: false,
      lastJumpCounter: command.jumpCounter,
      stepCooldown: 0,
    };
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
    sourceTick: serverTick >>> 0,
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
  if (command.primaryCounter !== predictionPrimaryCounter) {
    predictionPrimaryCounter = command.primaryCounter;
    if (predictedGrab) releasePredictedGrab();
  }
  if (predictedGrab) {
    if (!stepPropGrab(physicsEngine(), predictedGrab.grab, playerPose(command)))
      releasePredictedGrab();
  }
  if (manipulation)
    stepHostManipulationTarget(physicsEngine(), manipulation.target, playerPose(command));
  const events = physics.step(PHYSICS_DT, PHYSICS_SUBSTEPS);
  processGravityEvents(events);
  processPredictionContactEvents(events);
}

function localPredictedStates(): NetworkObjectState[] {
  if (!localPlayer) return [];
  const states: NetworkObjectState[] = [clonePlayer(localPlayer)];
  if (!physics || !predictedGrab) return states;
  const body = bodies.get(key(predictedGrab.grab.target));
  if (!body) return states;
  const state = physics.state(body.handle);
  states.push({
    ...body.state,
    kind: "body",
    id: { ...body.networkId },
    sourceTick: localPlayer.sourceTick,
    position: { ...state.position },
    rotation: { ...state.rotation },
    linearVelocity: { ...state.linearVelocity },
    angularVelocity: { ...state.angularVelocity },
    flags: body.state.flags | NETWORK_FLAG_HELD,
  });
  return states;
}

function clonePredictedBody(states: readonly NetworkObjectState[]): NetworkBodyState | null {
  const body = states.find((state): state is NetworkBodyState => state.kind === "body");
  return body ? cloneBody(body) : null;
}

function applyCheckpoint(checkpoint: PredictionCheckpointPacket): void {
  if (
    !physics ||
    !localPlayerId ||
    checkpoint.worldEpoch !== worldEpoch ||
    !sameId(checkpoint.player.id, localPlayerId)
  )
    return;
  const acknowledged = checkpoint.lastProcessedInputSequence ?? -1;
  if (acknowledged < lastAcknowledgedInputSequence) return;
  const acknowledgedRecord = predictionHistory.find(
    (record) => record.command.sequence === acknowledged,
  );
  const grabStartRecord =
    checkpoint.held?.startInputSequence === null ||
    checkpoint.held?.startInputSequence === undefined
      ? null
      : predictionHistory.find(
          (record) => record.command.sequence === checkpoint.held!.startInputSequence,
        );
  if (acknowledgedRecord || grabStartRecord)
    lastAcknowledgedPrimaryCounter =
      acknowledgedRecord?.command.primaryCounter ?? grabStartRecord!.command.primaryCounter;
  lastAcknowledgedInputSequence = acknowledged;
  const pending = predictionHistory
    .filter((record) => record.command.sequence > acknowledged)
    .map((record) => structuredClone(record.command));

  if (localPlayerProxy) {
    clearGravityVisitor(localPlayerProxy);
    physics.destroy(localPlayerProxy);
  }
  localPlayer = clonePlayer(checkpoint.player);
  predictionPrimaryCounter = lastAcknowledgedPrimaryCounter;
  localPlayerProxy = physics.createPlayerProxy(
    localPlayer.position,
    playerCapsule(localPlayer.crouched),
  );

  if (checkpoint.held) {
    const body = bodies.get(key(checkpoint.held.body.id));
    if (body) {
      if (predictedGrab && !sameId(predictedGrab.grab.target, body.networkId))
        releasePredictedGrab();
      body.state = cloneBody(checkpoint.held.body);
      rememberBodyState(body, checkpoint.held.body);
      physics.setBodyType(body.handle, "dynamic");
      physics.setBodyTransform(
        body.handle,
        checkpoint.held.body.position,
        checkpoint.held.body.rotation,
      );
      physics.setBodyVelocity(
        body.handle,
        checkpoint.held.body.linearVelocity,
        checkpoint.held.body.angularVelocity,
      );
      predictedGrab = {
        claimVersion: checkpoint.held.claimVersion,
        grab: {
          target: { ...checkpoint.held.body.id },
          distance: checkpoint.held.distance,
          relativeRotation: { ...checkpoint.held.relativeRotation },
          targetPosition: { ...checkpoint.held.targetPosition },
          targetRotation: { ...checkpoint.held.targetRotation },
          errorSeconds: checkpoint.held.errorSeconds,
        },
      };
    }
  } else {
    releasePredictedGrab();
  }

  predictionHistory = [];
  for (let index = 0; index < pending.length; index += 1) {
    const command = pending[index]!;
    const replayTick = checkpoint.serverTick + index + 1;
    simulateCommand(command, replayTick);
    const result = localPredictedStates();
    predictionHistory.push({
      command,
      serverTick: replayTick,
      player: clonePlayer(localPlayer),
      held: clonePredictedBody(result),
      proxyTick: replayTick,
    });
  }
  const newestSequence = pending.at(-1)?.sequence ?? acknowledged;
  nextInputSequence = Math.max(nextInputSequence, newestSequence + 1);
  const contacts = predictionContacts();
  const command = predictionHistory.at(-1)?.command ?? null;
  post({
    type: "local-states",
    states: localPredictedStates(),
    collisionStates: traceEnabled ? clientCollisionStates(contacts) : [],
    producedAtMs: performance.now(),
    discardedCatchUpSeconds,
    reconciled: true,
    inputSequence: newestSequence,
    acknowledgment: acknowledged < 0 ? null : acknowledged,
    replayCount: pending.length,
    contactIds: contacts.contactIds,
    supportIds: contacts.supportIds,
    command: command ? structuredClone(command) : null,
  });
}

function clientCollisionStates(contacts: {
  contactIds: RuntimeId[];
  supportIds: RuntimeId[];
}): NetworkObjectState[] {
  if (!physics || !localPlayer || !localPlayerProxy) return [];
  const playerPhysics = physics.state(localPlayerProxy);
  const player: NetworkPlayerState = {
    ...clonePlayer(localPlayer),
    position: { ...playerPhysics.position },
    rotation: { ...playerPhysics.rotation },
    linearVelocity: { ...playerPhysics.linearVelocity },
    angularVelocity: { ...playerPhysics.angularVelocity },
  };
  const forced = new Set([...contacts.contactIds, ...contacts.supportIds].map((id) => key(id)));
  if (predictedGrab) forced.add(key(predictedGrab.grab.target));
  const radiusSquared = TRACE_RADIUS_METRES * TRACE_RADIUS_METRES;
  const candidates: Array<{ distanceSquared: number; state: NetworkObjectState }> = [];
  for (const body of bodies.values()) {
    const bodyPhysics = physics.state(body.handle);
    const distanceSquared = vec3DistanceSquared(playerPhysics.position, bodyPhysics.position);
    if (distanceSquared > radiusSquared && !forced.has(key(body.networkId))) continue;
    candidates.push({
      distanceSquared,
      state: {
        ...cloneBody(body.state),
        sourceTick:
          predictedGrab && sameId(predictedGrab.grab.target, body.networkId)
            ? localPlayer.sourceTick
            : body.state.sourceTick,
        position: { ...bodyPhysics.position },
        rotation: { ...bodyPhysics.rotation },
        linearVelocity: { ...bodyPhysics.linearVelocity },
        angularVelocity: { ...bodyPhysics.angularVelocity },
        flags:
          (body.state.flags & ~NETWORK_FLAG_AWAKE) | (bodyPhysics.awake ? NETWORK_FLAG_AWAKE : 0),
      },
    });
  }
  for (const remote of remotePlayers.values()) {
    const remotePhysics = physics.state(remote.handle);
    const distanceSquared = vec3DistanceSquared(playerPhysics.position, remotePhysics.position);
    if (distanceSquared > radiusSquared && !forced.has(key(remote.networkId))) continue;
    candidates.push({
      distanceSquared,
      state: {
        ...clonePlayer(remote.state),
        position: { ...remotePhysics.position },
        rotation: { ...remotePhysics.rotation },
        linearVelocity: { ...remotePhysics.linearVelocity },
        angularVelocity: { ...remotePhysics.angularVelocity },
      },
    });
  }
  return [
    player,
    ...candidates
      .toSorted((a, b) => a.distanceSquared - b.distanceSquared)
      .slice(0, TRACE_MAX_NEARBY_OBJECTS)
      .map(({ state }) => state),
  ];
}

function releasePredictedGrab(): void {
  if (!physics || !predictedGrab) {
    predictedGrab = null;
    return;
  }
  const body = bodies.get(key(predictedGrab.grab.target));
  if (body) {
    physics.setBodyType(body.handle, "kinematic");
    physics.setBodyTransform(body.handle, body.state.position, body.state.rotation);
    physics.setBodyVelocity(body.handle, body.state.linearVelocity, body.state.angularVelocity);
  }
  predictedGrab = null;
}

function processInputEdges(): void {
  if (!input || !localPlayer) return;
  if (input.primaryCounter === lastPrimaryCounter) return;
  lastPrimaryCounter = input.primaryCounter;
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
    const requestId = nextManipulationRequestId++;
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
    rememberBodyState(body, state);
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
  rememberBodyState(body, message.state);
  physics.setBodyTransform(body.handle, message.state.position, message.state.rotation);
  physics.setBodyVelocity(body.handle, message.state.linearVelocity, message.state.angularVelocity);
  if (bundle && descriptor?.kind === "world-entity")
    applySurfaceMotor(physics, bundle, descriptor.entityIndex, body.handle, message.state.flags);
  if (!predictedGrab || !sameId(predictedGrab.grab.target, body.networkId))
    physics.setBodyType(body.handle, "kinematic");
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
    activePredictionContacts.delete(identity);
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
    pendingManipulation.forEach((pending, requestId) => {
      if (sameId(pending.target, id)) pendingManipulation.delete(requestId);
    });
    if (manipulation && sameId(manipulation.target.target, id)) manipulation = null;
  }
  for (const descriptor of message.created)
    descriptors.set(key(descriptor.id), structuredClone(descriptor));
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
      state: clonePlayer(state),
      history: [clonePlayer(state)],
    };
    remotePlayers.set(identity, remote);
  } else {
    remote.crouched = state.crouched;
    remote.state = clonePlayer(state);
    rememberPlayerState(remote, state);
  }
}

function applyProxyTargets(serverTick: number): void {
  if (!physics || !bundle) return;
  for (const body of bodies.values()) {
    if (predictedGrab && sameId(predictedGrab.grab.target, body.networkId)) continue;
    const descriptor = descriptors.get(key(body.networkId));
    const entity =
      descriptor?.kind === "world-entity" ? bundle.entities[descriptor.entityIndex] : null;
    if (entity?.body?.kind !== "dynamic-brush" && entity?.body?.kind !== "kinematic-brush")
      continue;
    const state = sampleHistory(body.history, serverTick) ?? body.state;
    physics.setKinematicTargetTransform(body.handle, state.position, state.rotation, PHYSICS_DT);
  }
  for (const remote of remotePlayers.values()) {
    const state = sampleHistory(remote.history, serverTick) ?? remote.state;
    physics.setKinematicTargetTransform(remote.handle, state.position, state.rotation, PHYSICS_DT);
  }
}

function processGravityEvents(events: PhysicsStepEvents): void {
  for (const event of events.sensorBegin) updateGravityOverlap(event.sensor, event.visitor, true);
  for (const event of events.sensorEnd) updateGravityOverlap(event.sensor, event.visitor, false);
}

function processPredictionContactEvents(events: PhysicsStepEvents): void {
  if (!localPlayerProxy) return;
  const update = (a: RuntimeId, b: RuntimeId, amount: 1 | -1): void => {
    const other = sameId(a, localPlayerProxy!) ? b : sameId(b, localPlayerProxy!) ? a : null;
    if (!other) return;
    const networkId = localToNetwork.get(key(other));
    if (!networkId) return;
    const identity = key(networkId);
    const current = activePredictionContacts.get(identity);
    const count = Math.max(0, (current?.count ?? 0) + amount);
    if (count === 0) activePredictionContacts.delete(identity);
    else activePredictionContacts.set(identity, { id: { ...networkId }, count });
  };
  for (const contact of events.contactBegin) update(contact.a, contact.b, 1);
  for (const contact of events.contactEnd) update(contact.a, contact.b, -1);
}

function predictionContacts(): { contactIds: RuntimeId[]; supportIds: RuntimeId[] } {
  const contactIds = [...activePredictionContacts.values()].map(({ id }) => ({ ...id }));
  if (!physics || !localPlayer || !localPlayerProxy) return { contactIds, supportIds: [] };
  const halfHeight =
    PLAYER_CAPSULE_RADIUS +
    (localPlayer.crouched ? PLAYER_CROUCHED_HALF_SEGMENT : PLAYER_CAPSULE_HALF_SEGMENT);
  const support = physics.raycastClosest(
    localPlayer.position,
    { x: 0, y: -(halfHeight + 0.15), z: 0 },
    { ignoreBodies: [localPlayerProxy] },
  );
  const supportId = support ? localToNetwork.get(key(support.body)) : null;
  return { contactIds, supportIds: supportId ? [{ ...supportId }] : [] };
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
      history: [cloneBody(state)],
    };
  }
  const type = spec.kind === "static-brush" ? "static" : "kinematic";
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
    history: [cloneBody(state)],
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

function playerPose(command: InputCommand = input!) {
  return {
    position: localPlayer!.position,
    yaw: localPlayer!.yaw,
    lookYaw: command.lookYaw,
    lookPitch: command.lookPitch,
  };
}

function rememberBodyState(body: LocalBody, state: NetworkBodyState): void {
  if (body.history.at(-1)?.authorityVersion !== state.authorityVersion) body.history = [];
  if (body.history.at(-1)?.stateSequence === state.stateSequence) return;
  body.history.push(cloneBody(state));
  while (body.history.length > PREDICTION_HISTORY_CAPACITY) body.history.shift();
}

function rememberPlayerState(player: RemotePlayer, state: NetworkPlayerState): void {
  if (player.history.at(-1)?.authorityVersion !== state.authorityVersion) player.history = [];
  if (player.history.at(-1)?.stateSequence === state.stateSequence) return;
  player.history.push(clonePlayer(state));
  while (player.history.length > PREDICTION_HISTORY_CAPACITY) player.history.shift();
}

function sampleHistory<T extends NetworkObjectState>(
  history: readonly T[],
  targetTick: number,
): T | null {
  if (history.length === 0) return null;
  const timed = history.map((state) => ({
    state,
    tick: unwrapTick32(state.sourceTick, targetTick),
  }));
  if (targetTick <= timed[0]!.tick) return cloneNetwork(timed[0]!.state);
  const latest = timed.at(-1)!;
  if (targetTick >= latest.tick) return cloneNetwork(latest.state);
  for (let index = 1; index < timed.length; index += 1) {
    const next = timed[index]!;
    if (next.tick < targetTick) continue;
    const previous = timed[index - 1]!;
    const span = next.tick - previous.tick;
    const amount = span <= 0 ? 1 : (targetTick - previous.tick) / span;
    return interpolateNetwork(previous.state, next.state, amount);
  }
  return cloneNetwork(latest.state);
}

function interpolateNetwork<T extends NetworkObjectState>(previous: T, next: T, amount: number): T {
  const common = {
    ...next,
    id: { ...next.id },
    position: mixVec3(previous.position, next.position, amount),
    rotation: mixQuat(previous.rotation, next.rotation, amount),
    linearVelocity: mixVec3(previous.linearVelocity, next.linearVelocity, amount),
    angularVelocity: mixVec3(previous.angularVelocity, next.angularVelocity, amount),
  };
  if (previous.kind === "player" && next.kind === "player") {
    return {
      ...common,
      kind: "player",
      yaw: mixAngle(previous.yaw, next.yaw, amount),
      verticalVelocity: mix(previous.verticalVelocity, next.verticalVelocity, amount),
      grounded: next.grounded,
      crouched: next.crouched,
      lastJumpCounter: next.lastJumpCounter,
      stepCooldown: mix(previous.stepCooldown, next.stepCooldown, amount),
    } as T;
  }
  return { ...common, kind: "body" } as T;
}

function cloneNetwork<T extends NetworkObjectState>(state: T): T {
  return (state.kind === "player" ? clonePlayer(state) : cloneBody(state)) as T;
}

function mixVec3(a: NetworkBodyState["position"], b: NetworkBodyState["position"], amount: number) {
  return { x: mix(a.x, b.x, amount), y: mix(a.y, b.y, amount), z: mix(a.z, b.z, amount) };
}

function mixQuat(a: NetworkBodyState["rotation"], b: NetworkBodyState["rotation"], amount: number) {
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const value = {
    x: mix(a.x, b.x * sign, amount),
    y: mix(a.y, b.y * sign, amount),
    z: mix(a.z, b.z * sign, amount),
    w: mix(a.w, b.w * sign, amount),
  };
  const length = Math.hypot(value.x, value.y, value.z, value.w) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
}

function mixAngle(a: number, b: number, amount: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * amount;
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
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

function vec3DistanceSquared(
  a: NetworkBodyState["position"],
  b: NetworkBodyState["position"],
): number {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const z = a.z - b.z;
  return x * x + y * y + z * z;
}

function post(message: PhysicsWorkerResponse): void {
  scope.postMessage(message);
}

function report(error: unknown): void {
  post({ type: "error", message: error instanceof Error ? error.message : "owner physics failed" });
}
