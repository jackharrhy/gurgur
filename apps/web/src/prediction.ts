import {
  PHYSICS_DT,
  PHYSICS_SUBSTEPS,
  LOCAL_PHYSICS_RADIUS_METRES,
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
  stepPlayerController,
  type BodyKind,
  type PlayerControllerState,
} from "@gurgur/physics";

const MAX_INPUT_HISTORY = 120;
const SNAP_CORRECTION_METRES = 0.25;
const CORRECTION_SECONDS = 0.1;

const idKey = (id: RuntimeId): string => `${id.index}:${id.generation}`;
type PredictedFrame = { command: InputCommand; state: PlayerControllerState | null };
type CollisionProxy = {
  handle: RuntimeId;
  networkId: RuntimeId;
  bodyKind: BodyKind;
  locallySimulated: boolean;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
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
    this.#correction = zero();
    this.#correctionSecondsRemaining = 0;
    this.#onPresentation(null, []);
  }

  async setWorld(message: WorldMessage): Promise<void> {
    if (
      this.#physics
      && this.#worldEpoch === message.worldEpoch
      && this.#mapRevision === message.bundle.mapRevision
    ) return;
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
    this.#correction = zero();
    this.#correctionSecondsRemaining = 0;
    this.#pendingAuthority = null;
    this.#onPresentation(null, []);

    const physics = await PhysicsWorld.create(this.#wasmUrl ? {
      locateFile: (path) => path.endsWith("box3d.wasm") ? this.#wasmUrl! : path,
    } : undefined);
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
      const bodyKind: BodyKind = runtime.classname === "func_physics"
        ? "dynamic"
        : runtime.classname === "func_button" ? "static" : "kinematic";
      const type = bodyKind === "dynamic" ? "kinematic" : bodyKind;
      const authored = message.bundle.entities.find((entity) => entity.authoredId === runtime.authoredId);
      const material = {
        density: Number(authored?.runtimeProperties.density ?? 1),
        friction: Number(authored?.runtimeProperties.friction ?? 0.6),
        restitution: Number(authored?.runtimeProperties.restitution ?? 0),
      };
      const brushIndices = runtime.brushIndices ?? [runtime.brushIndex];
      const hulls = brushIndices.map((index) => ({
        vertices: message.bundle.brushes[index]!.worldVertices.map((vertex) => ({
          x: vertex.x - brush.center.x, y: vertex.y - brush.center.y, z: vertex.z - brush.center.z,
        })),
      }));
      proxies.set(idKey(runtime.id), {
        handle: brushIndices.length === 1
          ? physics.createHull({ type, position: brush.center, rotation, vertices: brush.localVertices, ...material })
          : physics.createCompoundHulls({ type, position: brush.center, rotation, hulls, ...material }),
        networkId: { ...runtime.id },
        bodyKind,
        locallySimulated: false,
        position: { ...brush.center },
        rotation,
        linearVelocity: zero(),
        angularVelocity: zero(),
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
    this.#updateLocalPhysicsScope();
    this.#state = stepPlayerController(this.#physics, this.#state, command, PHYSICS_DT);
    this.#updatePlayerProxy();
    this.#stepPhysics();
    frame.state = cloneState(this.#state);
    this.#decayCorrection();
    this.#emit();
  }

  reconcile(snapshot: Snapshot): void {
    if (!this.#physics || !this.#localPlayer) {
      this.#pendingAuthority = snapshot;
      return;
    }
    if (snapshot.worldEpoch !== this.#worldEpoch) return;
    const authority = snapshot.players.find((player) => idKey(player.id) === idKey(this.#localPlayer!));
    if (!authority) return;

    const before = this.#state ? { ...this.#state.position } : null;
    this.#synchronizeCollisionProxies(snapshot);
    this.#history = this.#history.filter(
      (frame) => frame.command.sequence > authority.lastProcessedInputSequence,
    );
    this.#state = controllerState(authority);
    this.#updatePlayerProxy();
    this.#updateLocalPhysicsScope();
    for (const frame of this.#history) {
      this.#updateLocalPhysicsScope();
      this.#state = stepPlayerController(this.#physics, this.#state, frame.command, PHYSICS_DT);
      this.#updatePlayerProxy();
      this.#stepPhysics();
      frame.state = cloneState(this.#state);
    }

    if (before) {
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

  get pendingInputCount(): number { return this.#history.length; }
  get correctionMagnitude(): number { return length(this.#correction); }
  get predictedPosition(): Vec3 | null { return this.#state ? { ...this.#state.position } : null; }
  get predictedGrounded(): boolean | null { return this.#state?.grounded ?? null; }
  predictedBody(id: RuntimeId): BodySnapshot | null {
    const proxy = this.#collisionProxies.get(idKey(id));
    return proxy ? {
      id: { ...id },
      position: { ...proxy.position },
      rotation: { ...proxy.rotation },
      linearVelocity: { ...proxy.linearVelocity },
      angularVelocity: { ...proxy.angularVelocity },
    } : null;
  }
  get predictedBodies(): BodySnapshot[] { return this.#nearbyPredictedBodies(); }
  get lastReconciliationError(): number { return this.#lastReconciliationError; }

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
    this.#onPresentation({
      id: this.#localPlayer,
      position: this.#presentationPosition()!,
      rotation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    }, this.#nearbyPredictedBodies());
  }

  #synchronizeCollisionProxies(snapshot: Snapshot): void {
    if (!this.#physics) return;
    for (const body of snapshot.bodies) {
      const proxy = this.#collisionProxies.get(idKey(body.id));
      if (!proxy) continue;
      proxy.position = { ...body.position };
      proxy.rotation = { ...body.rotation };
      proxy.linearVelocity = { ...(body.linearVelocity ?? zero()) };
      proxy.angularVelocity = { ...(body.angularVelocity ?? zero()) };
      this.#physics.setBodyTransform(proxy.handle, proxy.position, proxy.rotation);
      this.#physics.setBodyVelocity(
        proxy.handle,
        proxy.bodyKind === "dynamic" && !proxy.locallySimulated ? zero() : proxy.linearVelocity,
        proxy.bodyKind === "dynamic" && !proxy.locallySimulated ? zero() : proxy.angularVelocity,
      );
    }
  }

  #stepPhysics(): void {
    if (!this.#physics) return;
    this.#physics.step(PHYSICS_DT, PHYSICS_SUBSTEPS);
    for (const proxy of this.#collisionProxies.values()) {
      if (proxy.bodyKind === "dynamic" && !proxy.locallySimulated) continue;
      const state = this.#physics.state(proxy.handle);
      proxy.position = { ...state.position };
      proxy.rotation = { ...state.rotation };
      proxy.linearVelocity = { ...state.linearVelocity };
      proxy.angularVelocity = { ...state.angularVelocity };
    }
  }

  #updateLocalPhysicsScope(): void {
    if (!this.#physics || !this.#state) return;
    for (const proxy of this.#collisionProxies.values()) {
      if (proxy.bodyKind !== "dynamic") continue;
      const shouldSimulate = length(subtract(proxy.position, this.#state.position)) <= LOCAL_PHYSICS_RADIUS_METRES;
      if (shouldSimulate === proxy.locallySimulated) continue;
      proxy.locallySimulated = shouldSimulate;
      this.#physics.setBodyType(proxy.handle, shouldSimulate ? "dynamic" : "kinematic");
      this.#physics.setBodyVelocity(
        proxy.handle,
        shouldSimulate ? proxy.linearVelocity : zero(),
        shouldSimulate ? proxy.angularVelocity : zero(),
      );
      if (!shouldSimulate) {
        proxy.linearVelocity = zero();
        proxy.angularVelocity = zero();
      }
    }
  }

  #nearbyPredictedBodies(): BodySnapshot[] {
    if (!this.#state) return [];
    return [...this.#collisionProxies.values()].flatMap((proxy) =>
      length(subtract(proxy.position, this.#state!.position)) <= LOCAL_PHYSICS_RADIUS_METRES
        ? [{
          id: { ...proxy.networkId },
          position: { ...proxy.position },
          rotation: { ...proxy.rotation },
          linearVelocity: { ...proxy.linearVelocity },
          angularVelocity: { ...proxy.angularVelocity },
        }]
        : [],
    );
  }

  #updatePlayerProxy(): void {
    if (!this.#physics || !this.#playerProxy || !this.#state) return;
    if (this.#state.crouched !== this.#playerProxyCrouched) {
      this.#physics.destroy(this.#playerProxy);
      this.#playerProxy = this.#physics.createPlayerProxy(this.#state.position, { crouched: this.#state.crouched });
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

function zero(): Vec3 { return { x: 0, y: 0, z: 0 }; }
function identityRotation(): Quat { return { x: 0, y: 0, z: 0, w: 1 }; }
function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function subtract(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function multiply(value: Vec3, amount: number): Vec3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}
function length(value: Vec3): number { return Math.hypot(value.x, value.y, value.z); }
