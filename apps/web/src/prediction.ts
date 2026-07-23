import {
  FULL_RATE_BODY_RADIUS_METRES,
  PHYSICS_DT,
  PHYSICS_SUBSTEPS,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_TELEPORT,
  STATE_ALWAYS_NEAR_BODY_SLOTS,
  STATE_EXTRAPOLATION_MAX_TICKS,
  type BodySnapshot,
  type InputCommand,
  type PlayerStateSnapshot,
  type Quat,
  type RuntimeId,
  type Snapshot,
  type Vec3,
  type WorldMessage,
} from "@gurgur/shared";
import {
  PhysicsWorld,
  PLAYER_CROUCHED_HALF_SEGMENT,
  PLAYER_GRAVITY,
  PLAYER_MAX_FIXED_TICK_DISPLACEMENT,
  PLAYER_SPEED,
  stepPlayerController,
  type PlayerControllerState,
} from "@gurgur/physics";

const MAX_INPUT_HISTORY = 120;
const PREDICTION_STALL_RESET_TICKS = 30;
const PREDICTION_DIVERGENCE_BUFFER_METRES = 2;
const SNAP_CORRECTION_METRES = 0.25;
const CORRECTION_SECONDS = 0.1;

const idKey = (id: RuntimeId): string => `${id.index}:${id.generation}`;
type PredictedFrame = {
  command: InputCommand;
  state: PlayerControllerState | null;
};
type CollisionProxy = {
  handle: RuntimeId;
  networkId: RuntimeId;
  contactPresentation: boolean;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  extrapolationTicksRemaining: number;
  freshnessTicksRemaining: number;
  authorityTick: number;
  collisionEnabled: boolean;
  holdWhenStale: boolean;
};

export class PlayerPredictor {
  readonly #onPresentation: (body: BodySnapshot | null, bodies: BodySnapshot[]) => void;
  readonly #wasmUrl: string | null;
  #physics: PhysicsWorld | null = null;
  #localPlayer: RuntimeId | null = null;
  #state: PlayerControllerState | null = null;
  #history: PredictedFrame[] = [];
  #correction: Vec3 = { x: 0, y: 0, z: 0 };
  #correctionSecondsRemaining = 0;
  #lastReconciliationError = 0;
  #pendingAuthority: Snapshot | null = null;
  #worldEpoch: number | null = null;
  #latestAuthorityTick: number | null = null;
  #lastAuthorityPosition: Vec3 | null = null;
  #mapRevision: string | null = null;
  #loadGeneration = 0;
  #collisionProxies = new Map<string, CollisionProxy>();
  #playerProxy: RuntimeId | null = null;
  #playerProxyCrouched = false;

  constructor(
    onPresentation: (body: BodySnapshot | null, bodies: BodySnapshot[]) => void,
    options: { wasmUrl?: string } = {},
  ) {
    this.#onPresentation = onPresentation;
    this.#wasmUrl = options.wasmUrl ?? null;
  }

  setLocalPlayer(id: RuntimeId): void {
    if (this.#localPlayer && idKey(this.#localPlayer) === idKey(id)) return;
    this.#localPlayer = id;
    this.#state = null;
    this.#history = [];
    this.#latestAuthorityTick = null;
    this.#lastAuthorityPosition = null;
    this.#correction = zero();
    this.#correctionSecondsRemaining = 0;
    this.#onPresentation(null, []);
  }

  async setWorld(message: WorldMessage): Promise<void> {
    if (
      this.#physics &&
      this.#worldEpoch === message.worldEpoch &&
      this.#mapRevision === message.bundle.mapRevision
    )
      return;
    const generation = ++this.#loadGeneration;
    this.#physics?.dispose();
    this.#physics = null;
    this.#collisionProxies.clear();
    this.#playerProxy = null;
    this.#playerProxyCrouched = false;
    this.#worldEpoch = message.worldEpoch;
    this.#mapRevision = message.bundle.mapRevision;
    this.#state = null;
    this.#history = [];
    this.#latestAuthorityTick = null;
    this.#lastAuthorityPosition = null;
    this.#correction = zero();
    this.#correctionSecondsRemaining = 0;
    this.#pendingAuthority = null;
    this.#onPresentation(null, []);

    const physics = await PhysicsWorld.create(
      this.#wasmUrl
        ? {
            locateFile: (path) => (path.endsWith("box3d.wasm") ? this.#wasmUrl! : path),
          }
        : undefined,
    );
    physics.createStaticMesh({
      vertices: message.bundle.staticCollision.vertices,
      triangles: message.bundle.staticCollision.triangles,
    });
    const proxies = new Map<string, CollisionProxy>();
    for (const runtime of message.runtimeEntities) {
      if (!("brushIndex" in runtime)) continue;
      const brush = message.bundle.brushes[runtime.brushIndex];
      if (!brush) throw new Error(`runtime brush ${runtime.brushIndex} does not exist`);
      const rotation = identityRotation();
      const bodyKind =
        runtime.classname === "func_physics"
          ? "dynamic"
          : runtime.classname === "func_button"
            ? "static"
            : "kinematic";
      const type = bodyKind === "dynamic" ? "kinematic" : bodyKind;
      const authored = message.bundle.entities.find(
        (entity) => entity.authoredId === runtime.authoredId,
      );
      const material = {
        density: Number(authored?.runtimeProperties.density ?? 1),
        friction: Number(authored?.runtimeProperties.friction ?? 0.6),
        restitution: Number(authored?.runtimeProperties.restitution ?? 0),
      };
      const brushIndices = runtime.brushIndices ?? [runtime.brushIndex];
      const hulls = brushIndices.map((index) => ({
        vertices: message.bundle.brushes[index]!.worldVertices.map((vertex) => ({
          x: vertex.x - brush.center.x,
          y: vertex.y - brush.center.y,
          z: vertex.z - brush.center.z,
        })),
      }));
      proxies.set(idKey(runtime.id), {
        handle:
          brushIndices.length === 1
            ? physics.createHull({
                type,
                position: brush.center,
                rotation,
                vertices: brush.localVertices,
                ...material,
              })
            : physics.createCompoundHulls({
                type,
                position: brush.center,
                rotation,
                hulls,
                ...material,
              }),
        networkId: { ...runtime.id },
        contactPresentation: runtime.classname === "func_physics",
        position: { ...brush.center },
        rotation,
        linearVelocity: zero(),
        angularVelocity: zero(),
        extrapolationTicksRemaining: 0,
        freshnessTicksRemaining: 0,
        authorityTick: -1,
        collisionEnabled: true,
        holdWhenStale: false,
      });
    }
    physics.step(PHYSICS_DT, PHYSICS_SUBSTEPS);
    if (generation !== this.#loadGeneration) {
      physics.dispose();
      return;
    }
    this.#physics = physics;
    this.#collisionProxies = proxies;
    this.#playerProxy = physics.createPlayerProxy({ x: 0, y: -1_000, z: 0 });
    const authority = this.#pendingAuthority;
    this.#pendingAuthority = null;
    if (authority) this.reconcile(authority);
  }

  pushInput(command: InputCommand): void {
    if (command.worldEpoch !== this.#worldEpoch) return;
    const frame: PredictedFrame = { command, state: null };
    this.#history.push(frame);
    if (this.#history.length > MAX_INPUT_HISTORY) this.#history.shift();
    if (!this.#physics || !this.#state) return;
    const previous = this.#state;
    const predicted = stepPlayerController(this.#physics, previous, command, PHYSICS_DT);
    if (
      !plausiblePredictionStep(previous, predicted) ||
      !plausibleFromAuthority(this.#lastAuthorityPosition, predicted, this.#history.length)
    ) {
      this.#history = [];
      this.#state = {
        ...previous,
        yaw: command.lookYaw,
        lastJumpCounter: command.jumpCounter,
      };
      this.#correction = zero();
      this.#correctionSecondsRemaining = 0;
      this.#freezeCollisionProxies();
      this.#updatePlayerProxy();
      this.#emit();
      return;
    }
    this.#state = predicted;
    this.#updatePlayerProxy();
    this.#stepPhysics();
    frame.state = cloneState(this.#state);
    this.#decayCorrection();
    this.#emit();
  }

  reconcile(snapshot: Snapshot, reconcilePlayer = true): void {
    if (!this.#physics || !this.#localPlayer) {
      this.#pendingAuthority = snapshot;
      return;
    }
    if (snapshot.worldEpoch !== this.#worldEpoch) return;
    if (!reconcilePlayer) {
      this.#synchronizeCollisionProxies(snapshot);
      return;
    }
    if (this.#latestAuthorityTick !== null && snapshot.serverTick <= this.#latestAuthorityTick) {
      this.#synchronizeCollisionProxies(snapshot);
      return;
    }
    const authority = snapshot.players.find(
      (player) => idKey(player.id) === idKey(this.#localPlayer!),
    );
    if (!authority) return;
    const teleportMarked =
      ((snapshot.bodies.find((body) => idKey(body.id) === idKey(this.#localPlayer!))?.flags ?? 0) &
        SNAPSHOT_FLAG_TELEPORT) !==
      0;
    const teleported =
      teleportMarked &&
      (!this.#lastAuthorityPosition ||
        length(subtract(authority.position, this.#lastAuthorityPosition)) >= 2);

    const before = this.#state ? { ...this.#state.position } : null;
    const stalled =
      this.#latestAuthorityTick !== null &&
      snapshot.serverTick - this.#latestAuthorityTick > PREDICTION_STALL_RESET_TICKS;
    this.#latestAuthorityTick = Math.max(
      this.#latestAuthorityTick ?? snapshot.serverTick,
      snapshot.serverTick,
    );
    this.#lastAuthorityPosition = { ...authority.position };
    if (stalled || teleported) this.#freezeCollisionProxies();
    this.#synchronizeCollisionProxies(snapshot);
    this.#history = this.#history.filter(
      (frame) => frame.command.sequence > authority.lastProcessedInputSequence,
    );
    this.#state = controllerState(authority);
    this.#updatePlayerProxy();
    if (stalled || teleported) {
      this.#history = [];
    } else {
      for (const frame of this.#history) {
        const predicted = stepPlayerController(
          this.#physics,
          this.#state,
          frame.command,
          PHYSICS_DT,
        );
        if (
          !plausiblePredictionStep(this.#state, predicted) ||
          !plausibleFromAuthority(authority.position, predicted, this.#history.length)
        ) {
          this.#history = [];
          this.#state = controllerState(authority);
          this.#freezeCollisionProxies();
          this.#updatePlayerProxy();
          break;
        }
        this.#state = predicted;
        this.#updatePlayerProxy();
        this.#stepPhysics(false);
        frame.state = cloneState(this.#state);
      }
    }

    if (before && !teleported) {
      const delta = subtract(before, this.#state.position);
      this.#lastReconciliationError = length(delta);
      const combined = add(this.#correction, delta);
      if (length(delta) < SNAP_CORRECTION_METRES && length(combined) < SNAP_CORRECTION_METRES) {
        this.#correction = combined;
        if (length(delta) > 0.0001) this.#correctionSecondsRemaining = CORRECTION_SECONDS;
      } else {
        this.#correction = zero();
        this.#correctionSecondsRemaining = 0;
      }
    } else {
      this.#lastReconciliationError = 0;
      this.#correction = zero();
      this.#correctionSecondsRemaining = 0;
    }
    this.#emit();
  }

  get pendingInputCount(): number {
    return this.#history.length;
  }
  get correctionMagnitude(): number {
    return length(this.#correction);
  }
  get predictedPosition(): Vec3 | null {
    return this.#state ? { ...this.#state.position } : null;
  }
  get predictedGrounded(): boolean | null {
    return this.#state?.grounded ?? null;
  }
  predictedBody(id: RuntimeId): BodySnapshot | null {
    const proxy = this.#collisionProxies.get(idKey(id));
    return proxy
      ? {
          id: { ...id },
          position: { ...proxy.position },
          rotation: { ...proxy.rotation },
          linearVelocity: { ...proxy.linearVelocity },
          angularVelocity: { ...proxy.angularVelocity },
        }
      : null;
  }
  get predictedBodies(): BodySnapshot[] {
    if (!this.#state) return [];
    return [...this.#collisionProxies.values()]
      .filter(
        (proxy) =>
          proxy.contactPresentation &&
          proxy.collisionEnabled &&
          length(subtract(proxy.position, this.#state!.position)) <= FULL_RATE_BODY_RADIUS_METRES,
      )
      .toSorted(
        (left, right) =>
          length(subtract(left.position, this.#state!.position)) -
          length(subtract(right.position, this.#state!.position)),
      )
      .slice(0, STATE_ALWAYS_NEAR_BODY_SLOTS)
      .map((proxy) => ({
        id: { ...proxy.networkId },
        position: { ...proxy.position },
        rotation: { ...proxy.rotation },
        linearVelocity: { ...proxy.linearVelocity },
        angularVelocity: { ...proxy.angularVelocity },
      }));
  }
  get lastReconciliationError(): number {
    return this.#lastReconciliationError;
  }

  dispose(): void {
    this.#loadGeneration += 1;
    this.#physics?.dispose();
    this.#physics = null;
    this.#collisionProxies.clear();
    this.#playerProxy = null;
    this.#playerProxyCrouched = false;
    this.#onPresentation(null, []);
  }

  #presentationPosition(): Vec3 | null {
    if (!this.#state) return null;
    if (!this.#physics || length(this.#correction) < 0.000001) return { ...this.#state.position };
    return this.#physics.moveCapsule(
      this.#state.position,
      this.#correction,
      this.#state.crouched ? { halfSegment: PLAYER_CROUCHED_HALF_SEGMENT } : {},
    );
  }

  #decayCorrection(): void {
    if (this.#correctionSecondsRemaining <= 0) return;
    const remaining = Math.max(0, this.#correctionSecondsRemaining - PHYSICS_DT);
    const amount = remaining / this.#correctionSecondsRemaining;
    this.#correction = multiply(this.#correction, amount);
    this.#correctionSecondsRemaining = remaining;
  }

  #emit(): void {
    if (!this.#state || !this.#localPlayer) return;
    const yaw = this.#state.yaw;
    this.#onPresentation(
      {
        id: this.#localPlayer,
        position: this.#presentationPosition()!,
        rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
      },
      this.predictedBodies,
    );
  }

  #synchronizeCollisionProxies(snapshot: Snapshot): void {
    if (!this.#physics) return;
    for (const body of snapshot.bodies) {
      const proxy = this.#collisionProxies.get(idKey(body.id));
      if (!proxy || snapshot.serverTick <= proxy.authorityTick) continue;
      proxy.authorityTick = snapshot.serverTick;
      proxy.position = { ...body.position };
      proxy.rotation = { ...body.rotation };
      proxy.linearVelocity = { ...(body.linearVelocity ?? zero()) };
      proxy.angularVelocity = { ...(body.angularVelocity ?? zero()) };
      proxy.extrapolationTicksRemaining = STATE_EXTRAPOLATION_MAX_TICKS;
      proxy.freshnessTicksRemaining = STATE_EXTRAPOLATION_MAX_TICKS;
      proxy.holdWhenStale = ((body.flags ?? 0) & SNAPSHOT_FLAG_SLEEP) !== 0;
      this.#physics.setBodyTransform(proxy.handle, proxy.position, proxy.rotation);
      this.#physics.setBodyVelocity(proxy.handle, proxy.linearVelocity, proxy.angularVelocity);
      if (!proxy.collisionEnabled) {
        this.#physics.setBodyEnabled(proxy.handle, true);
        proxy.collisionEnabled = true;
      }
    }
  }

  #stepPhysics(consumeFreshness = true): void {
    if (!this.#physics) return;
    for (const proxy of this.#collisionProxies.values()) {
      const freshnessExpired = consumeFreshness && proxy.freshnessTicksRemaining <= 0;
      if (consumeFreshness && proxy.freshnessTicksRemaining > 0) {
        proxy.freshnessTicksRemaining -= 1;
      }
      if (proxy.extrapolationTicksRemaining > 0) {
        proxy.extrapolationTicksRemaining -= 1;
      } else {
        proxy.linearVelocity = zero();
        proxy.angularVelocity = zero();
        this.#physics.setBodyVelocity(proxy.handle, proxy.linearVelocity, proxy.angularVelocity);
      }
      if (
        freshnessExpired &&
        proxy.contactPresentation &&
        !proxy.holdWhenStale &&
        proxy.collisionEnabled
      ) {
        this.#physics.setBodyEnabled(proxy.handle, false);
        proxy.collisionEnabled = false;
      }
    }
    this.#physics.step(PHYSICS_DT, PHYSICS_SUBSTEPS);
    for (const proxy of this.#collisionProxies.values()) {
      const state = this.#physics.state(proxy.handle);
      proxy.position = { ...state.position };
      proxy.rotation = { ...state.rotation };
      proxy.linearVelocity = { ...state.linearVelocity };
      proxy.angularVelocity = { ...state.angularVelocity };
    }
  }

  #freezeCollisionProxies(): void {
    if (!this.#physics) return;
    for (const proxy of this.#collisionProxies.values()) {
      proxy.extrapolationTicksRemaining = 0;
      proxy.freshnessTicksRemaining = 0;
      proxy.linearVelocity = zero();
      proxy.angularVelocity = zero();
      this.#physics.setBodyVelocity(proxy.handle, proxy.linearVelocity, proxy.angularVelocity);
      if (proxy.contactPresentation && !proxy.holdWhenStale && proxy.collisionEnabled) {
        this.#physics.setBodyEnabled(proxy.handle, false);
        proxy.collisionEnabled = false;
      }
    }
  }

  #updatePlayerProxy(): void {
    if (!this.#physics || !this.#playerProxy || !this.#state) return;
    if (this.#state.crouched !== this.#playerProxyCrouched) {
      this.#physics.destroy(this.#playerProxy);
      this.#playerProxy = this.#physics.createPlayerProxy(this.#state.position, {
        crouched: this.#state.crouched,
      });
      this.#playerProxyCrouched = this.#state.crouched;
    }
    this.#physics.setBodyTransform(this.#playerProxy, this.#state.position, {
      x: 0,
      y: Math.sin(this.#state.yaw / 2),
      z: 0,
      w: Math.cos(this.#state.yaw / 2),
    });
  }
}

function controllerState(authority: PlayerStateSnapshot): PlayerControllerState {
  return {
    position: { ...authority.position },
    verticalVelocity: authority.verticalVelocity,
    yaw: authority.yaw,
    grounded: authority.grounded,
    lastJumpCounter: authority.lastJumpCounter,
    stepCooldown: authority.stepCooldown,
    crouched: authority.crouched,
  };
}

function cloneState(state: PlayerControllerState): PlayerControllerState {
  return { ...state, position: { ...state.position } };
}

function zero(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}
function identityRotation(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function multiply(value: Vec3, amount: number): Vec3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}
function length(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function plausiblePredictionStep(
  before: PlayerControllerState,
  after: PlayerControllerState,
): boolean {
  return (
    [
      after.position.x,
      after.position.y,
      after.position.z,
      after.verticalVelocity,
      after.yaw,
      after.stepCooldown,
    ].every(Number.isFinite) &&
    length(subtract(after.position, before.position)) <= PLAYER_MAX_FIXED_TICK_DISPLACEMENT
  );
}

function plausibleFromAuthority(
  authority: Vec3 | null,
  predicted: PlayerControllerState,
  inputCount: number,
): boolean {
  if (!authority) return true;
  const seconds = Math.min(inputCount, MAX_INPUT_HISTORY) * PHYSICS_DT;
  return (
    Math.hypot(predicted.position.x - authority.x, predicted.position.z - authority.z) <=
      PLAYER_SPEED * seconds + PREDICTION_DIVERGENCE_BUFFER_METRES &&
    Math.abs(predicted.position.y - authority.y) <=
      0.5 * PLAYER_GRAVITY * seconds * seconds + PREDICTION_DIVERGENCE_BUFFER_METRES
  );
}
