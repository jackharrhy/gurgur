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
  type TraceControllerState,
  type TracePredictionEvent,
  type TracePredictionInputEvent,
  type TracePredictionProxy,
  type TraceReconciliationOutcome,
  type Vec3,
} from "@gurgur/engine";
import {
  PLAYER_CROUCHED_HALF_SEGMENT,
  PLAYER_CAPSULE_HALF_SEGMENT,
  PLAYER_CAPSULE_RADIUS,
  PLAYER_GRAVITY,
  PLAYER_MAX_FIXED_TICK_DISPLACEMENT,
  PLAYER_SPEED,
  stepPlayerController,
  type PlayerControllerState,
  type WorldMessage,
} from "@gurgur/game";
import { PhysicsWorld } from "@gurgur/engine";

const MAX_INPUT_HISTORY = 120;
const PREDICTION_STALL_RESET_TICKS = 30;
const PREDICTION_DIVERGENCE_BUFFER_METRES = 2;
const SNAP_CORRECTION_METRES = 0.25;
const CORRECTION_SECONDS = 0.1;
const PROXY_FRESHNESS_MS = STATE_EXTRAPOLATION_MAX_TICKS * PHYSICS_DT * 1_000;

const idKey = (id: RuntimeId): string => `${id.index}:${id.generation}`;
type PredictedFrame = {
  tick: number;
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
  freshUntilMs: number;
  authorityTick: number;
  collisionEnabled: boolean;
  holdWhenStale: boolean;
};

export class PlayerPredictor {
  readonly #onPresentation: (body: BodySnapshot | null, bodies: BodySnapshot[]) => void;
  readonly #onTrace: (event: TracePredictionEvent) => void;
  readonly #wasmUrl: string | null;
  readonly #now: () => number;
  #physics: PhysicsWorld | null = null;
  #localPlayer: RuntimeId | null = null;
  #state: PlayerControllerState | null = null;
  #history: PredictedFrame[] = [];
  #predictionTick: number | null = null;
  #latestIntent: InputCommand | null = null;
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
  #gravity = PLAYER_GRAVITY;
  #traceEnabled = false;

  constructor(
    onPresentation: (body: BodySnapshot | null, bodies: BodySnapshot[]) => void,
    options: {
      wasmUrl?: string;
      onTrace?: (event: TracePredictionEvent) => void;
      now?: () => number;
    } = {},
  ) {
    this.#onPresentation = onPresentation;
    this.#onTrace = options.onTrace ?? (() => {});
    this.#wasmUrl = options.wasmUrl ?? null;
    this.#now = options.now ?? (() => performance.now());
  }

  setTraceEnabled(enabled: boolean): void {
    this.#traceEnabled = enabled;
  }

  setLocalPlayer(id: RuntimeId): void {
    if (this.#localPlayer && idKey(this.#localPlayer) === idKey(id)) return;
    this.#localPlayer = id;
    this.#state = null;
    this.#history = [];
    this.#predictionTick = null;
    this.#latestIntent = null;
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
    this.#gravity = Math.max(0, -message.bundle.settings.gravity.y);
    this.#state = null;
    this.#history = [];
    this.#predictionTick = null;
    this.#latestIntent = null;
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
            gravity: message.bundle.settings.gravity,
          }
        : { gravity: message.bundle.settings.gravity },
    );
    physics.createStaticMesh({
      vertices: message.bundle.staticCollision.vertices,
      triangles: message.bundle.staticCollision.triangles,
    });
    const proxies = new Map<string, CollisionProxy>();
    for (const runtime of message.runtimeEntities) {
      if (runtime.kind !== "world-entity") continue;
      const authored = message.bundle.entities[runtime.entityIndex];
      const body = authored?.body;
      if (!authored || !body || body.kind === "sensor-brush") continue;
      const brushIndex = body.brushIndices[0];
      const brush = brushIndex === undefined ? null : message.bundle.brushes[brushIndex];
      if (!brush) throw new Error(`runtime entity ${runtime.entityIndex} has no brush`);
      const rotation = identityRotation();
      const bodyKind =
        body.kind === "dynamic-brush"
          ? "dynamic"
          : body.kind === "kinematic-brush"
            ? "kinematic"
            : "static";
      const type = bodyKind === "dynamic" ? "kinematic" : bodyKind;
      const material = {
        density: body.kind === "dynamic-brush" ? body.density : 1,
        friction: body.kind === "dynamic-brush" ? body.friction : 0.6,
        restitution: body.kind === "dynamic-brush" ? body.restitution : 0,
      };
      const brushIndices = body.brushIndices;
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
        contactPresentation: authored.kind === "physics-prop",
        position: { ...brush.center },
        rotation,
        linearVelocity: zero(),
        angularVelocity: zero(),
        extrapolationTicksRemaining: 0,
        freshUntilMs: 0,
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
    this.#playerProxy = physics.createPlayerProxy({ x: 0, y: -1_000, z: 0 }, playerCapsule(false));
    const authority = this.#pendingAuthority;
    this.#pendingAuthority = null;
    if (authority) this.reconcile(authority);
  }

  pushInput(command: InputCommand, targetServerTick?: number): void {
    const before = traceControllerState(this.#state);
    if (command.worldEpoch !== this.#worldEpoch) {
      this.#traceInput(command, "rejected-epoch", before);
      return;
    }
    this.#expireCollisionProxies(this.#now());
    const heldIntent = this.#latestIntent ?? command;
    this.#latestIntent = command;
    if (!this.#physics || !this.#state || this.#predictionTick === null) {
      this.#traceInput(command, "queued-without-world", before);
      return;
    }
    const targetTick =
      targetServerTick === undefined
        ? this.#predictionTick + 1
        : Math.max(0, Math.floor(targetServerTick));
    if (!Number.isSafeInteger(targetTick))
      throw new Error("prediction target server tick is invalid");
    if (targetTick <= this.#predictionTick) {
      this.#state = { ...this.#state, yaw: command.lookYaw };
      this.#updatePlayerProxy();
      this.#traceInput(command, "intent-only", before);
      this.#emit();
      return;
    }

    let outcome: TracePredictionInputEvent["outcome"] = "predicted";
    for (let tick = this.#predictionTick + 1; tick <= targetTick; tick += 1) {
      const effectiveIntent = tick === targetTick ? command : heldIntent;
      if (!this.#predictTick(tick, effectiveIntent)) {
        outcome = "implausible-reset";
        break;
      }
    }
    this.#traceInput(command, outcome, before);
    this.#emit();
  }

  reconcile(snapshot: Snapshot, reconcilePlayer = true, receivedAtMs = this.#now()): void {
    const before = traceControllerState(this.#state);
    const pendingInputCountBefore = this.#history.length;
    if (!this.#physics || !this.#localPlayer) {
      this.#pendingAuthority = snapshot;
      this.#traceReconciliation(
        snapshot,
        reconcilePlayer,
        "pending-world",
        null,
        before,
        pendingInputCountBefore,
        [],
      );
      return;
    }
    if (snapshot.worldEpoch !== this.#worldEpoch) {
      this.#traceReconciliation(
        snapshot,
        reconcilePlayer,
        "wrong-epoch",
        null,
        before,
        pendingInputCountBefore,
        [],
      );
      return;
    }
    if (!reconcilePlayer) {
      this.#synchronizeCollisionProxies(snapshot, receivedAtMs);
      this.#traceReconciliation(
        snapshot,
        reconcilePlayer,
        "proxy-only",
        null,
        before,
        pendingInputCountBefore,
        [],
      );
      return;
    }
    if (this.#latestAuthorityTick !== null && snapshot.serverTick <= this.#latestAuthorityTick) {
      this.#synchronizeCollisionProxies(snapshot, receivedAtMs);
      this.#traceReconciliation(
        snapshot,
        reconcilePlayer,
        "stale-snapshot",
        null,
        before,
        pendingInputCountBefore,
        [],
      );
      return;
    }
    const authority = snapshot.players.find(
      (player) => idKey(player.id) === idKey(this.#localPlayer!),
    );
    if (!authority) {
      this.#traceReconciliation(
        snapshot,
        reconcilePlayer,
        "missing-player",
        null,
        before,
        pendingInputCountBefore,
        [],
      );
      return;
    }
    const teleportMarked =
      ((snapshot.bodies.find((body) => idKey(body.id) === idKey(this.#localPlayer!))?.flags ?? 0) &
        SNAPSHOT_FLAG_TELEPORT) !==
      0;
    const teleported =
      teleportMarked &&
      (!this.#lastAuthorityPosition ||
        length(subtract(authority.position, this.#lastAuthorityPosition)) >= 2);

    const beforePosition = this.#state ? { ...this.#state.position } : null;
    const stalled =
      this.#latestAuthorityTick !== null &&
      snapshot.serverTick - this.#latestAuthorityTick > PREDICTION_STALL_RESET_TICKS;
    this.#latestAuthorityTick = Math.max(
      this.#latestAuthorityTick ?? snapshot.serverTick,
      snapshot.serverTick,
    );
    this.#lastAuthorityPosition = { ...authority.position };
    if (stalled || teleported) this.#freezeCollisionProxies();
    this.#synchronizeCollisionProxies(snapshot, receivedAtMs);
    if (this.#predictionTick === null) this.#predictionTick = snapshot.serverTick;
    this.#history = this.#history.filter((frame) => frame.tick > snapshot.serverTick);
    const replayedInputSequences = this.#history.map((frame) => frame.command.sequence);
    this.#state = controllerState(authority);
    this.#updatePlayerProxy();
    let replayReset = false;
    if (stalled || teleported) {
      this.#history = [];
      this.#predictionTick = snapshot.serverTick;
    } else {
      for (const frame of this.#history) {
        const predicted = stepPlayerController(
          this.#physics,
          this.#state,
          frame.command,
          PHYSICS_DT,
          this.#gravity,
        );
        if (
          !plausiblePredictionStep(this.#state, predicted) ||
          !plausibleFromAuthority(
            authority.position,
            predicted,
            Math.max(1, frame.tick - snapshot.serverTick),
            this.#gravity,
          )
        ) {
          this.#history = [];
          this.#state = controllerState(authority);
          this.#predictionTick = snapshot.serverTick;
          this.#freezeCollisionProxies();
          this.#updatePlayerProxy();
          replayReset = true;
          break;
        }
        this.#state = predicted;
        this.#updatePlayerProxy();
        this.#stepPhysics();
        frame.state = cloneState(this.#state);
      }
      this.#predictionTick = Math.max(
        snapshot.serverTick,
        this.#history.at(-1)?.tick ?? snapshot.serverTick,
      );
    }

    if (beforePosition && !teleported) {
      const delta = subtract(beforePosition, this.#state.position);
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
    this.#traceReconciliation(
      snapshot,
      reconcilePlayer,
      stalled
        ? "stalled-reset"
        : teleported
          ? "teleport-reset"
          : replayReset
            ? "implausible-reset"
            : "replayed",
      authority,
      before,
      pendingInputCountBefore,
      replayedInputSequences,
    );
    this.#emit();
  }

  get pendingInputCount(): number {
    return this.#history.length;
  }
  get predictionTick(): number | null {
    return this.#predictionTick;
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
    this.#expireCollisionProxies(this.#now());
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
      playerCapsule(this.#state.crouched),
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

  #traceInput(
    command: InputCommand,
    outcome: TracePredictionInputEvent["outcome"],
    before: TraceControllerState | null,
  ): void {
    if (!this.#traceEnabled) return;
    this.#onTrace({
      kind: "input",
      workerAtMs: performance.now(),
      workerTimeOriginUnixMs: performance.timeOrigin,
      sequence: command.sequence,
      clientTick: command.clientTick,
      outcome,
      before,
      after: traceControllerState(this.#state),
      pendingInputCount: this.#history.length,
      visibleCorrectionMetres: this.correctionMagnitude,
    });
  }

  #traceReconciliation(
    snapshot: Snapshot,
    reconcilePlayer: boolean,
    outcome: TraceReconciliationOutcome,
    authority: PlayerStateSnapshot | null,
    before: TraceControllerState | null,
    pendingInputCountBefore: number,
    replayedInputSequences: number[],
  ): void {
    if (!this.#traceEnabled) return;
    this.#onTrace({
      kind: "reconciliation",
      workerAtMs: performance.now(),
      workerTimeOriginUnixMs: performance.timeOrigin,
      serverTick: snapshot.serverTick,
      reconcilePlayer,
      outcome,
      authority: authority ? structuredClone(authority) : null,
      before,
      after: traceControllerState(this.#state),
      acknowledgedInputSequence: authority?.lastProcessedInputSequence ?? null,
      pendingInputCountBefore,
      pendingInputCountAfter: this.#history.length,
      replayedInputSequences: [...replayedInputSequences],
      rawErrorMetres:
        outcome === "replayed" || outcome === "stalled-reset" || outcome === "implausible-reset"
          ? this.#lastReconciliationError
          : null,
      visibleCorrectionMetres: this.correctionMagnitude,
      proxies: this.#traceProxies(),
    });
  }

  #traceProxies(): TracePredictionProxy[] {
    return [...this.#collisionProxies.values()].map((proxy) => ({
      id: { ...proxy.networkId },
      authorityTick: proxy.authorityTick,
      position: { ...proxy.position },
      rotation: { ...proxy.rotation },
      linearVelocity: { ...proxy.linearVelocity },
      angularVelocity: { ...proxy.angularVelocity },
      extrapolationTicksRemaining: proxy.extrapolationTicksRemaining,
      freshnessTicksRemaining: Math.max(
        0,
        Math.ceil((proxy.freshUntilMs - this.#now()) / (PHYSICS_DT * 1_000)),
      ),
      collisionEnabled: proxy.collisionEnabled,
      holdWhenStale: proxy.holdWhenStale,
      contactPresentation: proxy.contactPresentation,
    }));
  }

  #synchronizeCollisionProxies(snapshot: Snapshot, receivedAtMs: number): void {
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
      proxy.freshUntilMs = receivedAtMs + PROXY_FRESHNESS_MS;
      proxy.holdWhenStale = ((body.flags ?? 0) & SNAPSHOT_FLAG_SLEEP) !== 0;
      this.#physics.setBodyTransform(proxy.handle, proxy.position, proxy.rotation);
      this.#physics.setBodyVelocity(proxy.handle, proxy.linearVelocity, proxy.angularVelocity);
      if (!proxy.collisionEnabled) {
        this.#physics.setBodyEnabled(proxy.handle, true);
        proxy.collisionEnabled = true;
      }
    }
  }

  #stepPhysics(): void {
    if (!this.#physics) return;
    for (const proxy of this.#collisionProxies.values()) {
      if (proxy.extrapolationTicksRemaining > 0) {
        proxy.extrapolationTicksRemaining -= 1;
      } else {
        proxy.linearVelocity = zero();
        proxy.angularVelocity = zero();
        this.#physics.setBodyVelocity(proxy.handle, proxy.linearVelocity, proxy.angularVelocity);
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

  #expireCollisionProxies(nowMs: number): void {
    if (!this.#physics) return;
    for (const proxy of this.#collisionProxies.values()) {
      if (
        nowMs <= proxy.freshUntilMs + 0.000001 ||
        !proxy.contactPresentation ||
        proxy.holdWhenStale ||
        !proxy.collisionEnabled
      )
        continue;
      this.#physics.setBodyEnabled(proxy.handle, false);
      proxy.collisionEnabled = false;
    }
  }

  #predictTick(tick: number, command: InputCommand): boolean {
    if (!this.#physics || !this.#state) return false;
    const frame: PredictedFrame = { tick, command, state: null };
    this.#history.push(frame);
    if (this.#history.length > MAX_INPUT_HISTORY) this.#history.shift();
    this.#predictionTick = tick;
    const previous = this.#state;
    const predicted = stepPlayerController(
      this.#physics,
      previous,
      command,
      PHYSICS_DT,
      this.#gravity,
    );
    if (
      !plausiblePredictionStep(previous, predicted) ||
      !plausibleFromAuthority(
        this.#lastAuthorityPosition,
        predicted,
        Math.max(1, tick - (this.#latestAuthorityTick ?? tick)),
        this.#gravity,
      )
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
      return false;
    }
    this.#state = predicted;
    this.#updatePlayerProxy();
    this.#stepPhysics();
    frame.state = cloneState(this.#state);
    this.#decayCorrection();
    return true;
  }

  #freezeCollisionProxies(): void {
    if (!this.#physics) return;
    for (const proxy of this.#collisionProxies.values()) {
      proxy.extrapolationTicksRemaining = 0;
      proxy.freshUntilMs = 0;
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
      this.#playerProxy = this.#physics.createPlayerProxy(
        this.#state.position,
        playerCapsule(this.#state.crouched),
      );
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

function traceControllerState(state: PlayerControllerState | null): TraceControllerState | null {
  return state
    ? {
        position: { ...state.position },
        yaw: state.yaw,
        verticalVelocity: state.verticalVelocity,
        grounded: state.grounded,
        lastJumpCounter: state.lastJumpCounter,
        stepCooldown: state.stepCooldown,
        crouched: state.crouched,
      }
    : null;
}

function playerCapsule(crouched: boolean) {
  return {
    radius: PLAYER_CAPSULE_RADIUS,
    halfSegment: crouched ? PLAYER_CROUCHED_HALF_SEGMENT : PLAYER_CAPSULE_HALF_SEGMENT,
  };
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
  gravity: number,
): boolean {
  if (!authority) return true;
  const seconds = Math.min(inputCount, MAX_INPUT_HISTORY) * PHYSICS_DT;
  return (
    Math.hypot(predicted.position.x - authority.x, predicted.position.z - authority.z) <=
      PLAYER_SPEED * seconds + PREDICTION_DIVERGENCE_BUFFER_METRES &&
    Math.abs(predicted.position.y - authority.y) <=
      0.5 * gravity * seconds * seconds + PREDICTION_DIVERGENCE_BUFFER_METRES
  );
}
