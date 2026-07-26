import { PhysicsWorld, type PhysicsStepEvents } from "@gurgur/engine";
import {
  createGameSimulation,
  PLAYER_HALF_HEIGHT,
  stepPlayerController,
  type GameEngine,
  type GameSimulation,
  type WorldBundle,
  type WorldMessage,
} from "@gurgur/game";
import {
  MAX_CATCH_UP_TICKS,
  PHYSICS_DT,
  PHYSICS_HZ,
  PHYSICS_SUBSTEPS,
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL_TICKS,
  SNAPSHOT_FLAG_GRABBED,
  type InputCommand,
  type PhysicsDebugFrame,
  type Quat,
  type RuntimeId,
  type Snapshot,
  type Vec3,
} from "@gurgur/engine";
import {
  createRuntimeBodies,
  createRuntimeProp,
  runtimeBodyRef,
  type RuntimeBody,
} from "./runtime-bodies";
import type { PersistedWorld, WorldStore } from "./store";
import { WORLD_BUNDLE } from "./world";

const SAVE_INTERVAL_TICKS = 5 / PHYSICS_DT;
const MAX_DEV_PLAYERS = 16;
const MAX_DEV_PROPS = 64;
const DEV_PLAYER_PREFIX = "dev.mcp.player.";

export type DevPlayerIntentUpdate = {
  moveX?: number;
  moveZ?: number;
  lookYaw?: number;
  lookPitch?: number;
  crouch?: boolean;
  action?: "jump" | "interact" | "primary";
  interactTarget?: RuntimeId | null;
  durationSeconds?: number;
};

type DevPlayer = {
  controllerId: string;
  id: RuntimeId;
  sequence: number;
  moveX: number;
  moveZ: number;
  lookYaw: number;
  lookPitch: number;
  buttons: number;
  jumpCounter: number;
  interactCounter: number;
  interactTarget: RuntimeId | null;
  primaryCounter: number;
  stopAtTick: number | null;
};

export class AuthoritativeGame {
  readonly #physics: PhysicsWorld;
  readonly #bundle: WorldBundle;
  readonly #store: WorldStore;
  readonly #onSnapshot: (snapshot: Snapshot) => void;
  readonly #onWorld: (world: WorldMessage) => void;
  #runtimeBodies: RuntimeBody[] = [];
  #simulation!: GameSimulation;
  #saveRequested = false;
  readonly #tickDurationsMs: number[] = [];
  #discardedOverloadSeconds = 0;
  #worldEpoch: number;
  #serverTick: number;
  #accumulator = 0;
  #lastTime = 0;
  #timer: Timer | null = null;
  readonly #playerSpawn: Vec3 | null;
  #extraDynamicBodyCount = 0;
  readonly #devBodyKeys = new Set<string>();
  readonly #devPlayers = new Map<string, DevPlayer>();
  #devBodySequence = 0;

  private constructor(
    physics: PhysicsWorld,
    bundle: WorldBundle,
    store: WorldStore,
    onSnapshot: (snapshot: Snapshot) => void,
    onWorld: (world: WorldMessage) => void,
    worldEpoch: number,
    serverTick: number,
    playerSpawn: Vec3 | null,
  ) {
    this.#physics = physics;
    this.#bundle = bundle;
    this.#store = store;
    this.#onSnapshot = onSnapshot;
    this.#onWorld = onWorld;
    this.#worldEpoch = worldEpoch;
    this.#serverTick = serverTick;
    this.#playerSpawn = playerSpawn ? { ...playerSpawn } : null;
  }

  static async create(
    store: WorldStore,
    onSnapshot: (snapshot: Snapshot) => void,
    onWorld: (world: WorldMessage) => void,
    options: { playerSpawn?: Vec3; extraDynamicBodies?: number; worldBundle?: WorldBundle } = {},
  ): Promise<AuthoritativeGame> {
    const bundle = options.worldBundle ?? WORLD_BUNDLE;
    const physics = await PhysicsWorld.create({ gravity: bundle.settings.gravity });
    physics.createStaticMesh({
      vertices: bundle.staticCollision.vertices,
      triangles: bundle.staticCollision.triangles,
    });
    const restored = store.load(bundle.mapRevision);
    const game = new AuthoritativeGame(
      physics,
      bundle,
      store,
      onSnapshot,
      onWorld,
      restored?.worldEpoch ?? 1,
      restored?.serverTick ?? 0,
      options.playerSpawn ? { ...options.playerSpawn } : null,
    );
    game.#extraDynamicBodyCount = options.extraDynamicBodies ?? 0;
    game.#runtimeBodies = createRuntimeBodies(
      physics,
      bundle,
      restored,
      game.#extraDynamicBodyCount,
    );
    game.#simulation = game.#createGameSimulation(restored);
    return game;
  }

  get worldEpoch(): number {
    return this.#worldEpoch;
  }
  get serverTick(): number {
    return this.#serverTick;
  }
  get mapRevision(): string {
    return this.#bundle.mapRevision;
  }
  physicsDebugFrame(maxPrimitives?: number): PhysicsDebugFrame {
    return {
      worldEpoch: this.#worldEpoch,
      serverTick: this.#serverTick,
      ...this.#physics.debugDraw(maxPrimitives),
    };
  }
  playerPosition(id: RuntimeId): Vec3 | null {
    return this.#simulation.players.position(id);
  }
  beginInputStream(id: RuntimeId): boolean {
    return this.#simulation.players.beginInputStream(id);
  }
  metrics(): {
    tickP95Ms: number;
    tickP99Ms: number;
    tickMaxMs: number;
    discardedOverloadSeconds: number;
  } {
    const sorted = [...this.#tickDurationsMs].toSorted((a, b) => a - b);
    const percentile = (amount: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))] ?? 0;
    return {
      tickP95Ms: percentile(0.95),
      tickP99Ms: percentile(0.99),
      tickMaxMs: sorted.at(-1) ?? 0,
      discardedOverloadSeconds: this.#discardedOverloadSeconds,
    };
  }

  canResumePlayer(persistentId: string): boolean {
    return this.#simulation.players.canResume(persistentId);
  }

  connectPlayer(persistentId: string = crypto.randomUUID()): RuntimeId {
    return this.#simulation.players.connect(persistentId);
  }

  disconnectPlayer(id: RuntimeId): boolean {
    return this.#simulation.players.disconnect(id);
  }

  acceptInput(id: RuntimeId, command: InputCommand): boolean {
    return this.#simulation.players.acceptInput(id, command, this.#worldEpoch);
  }

  devWorldState(connectedNetworkPlayers: readonly RuntimeId[] = []) {
    const connected = new Set(connectedNetworkPlayers.map(key));
    const controllers = new Map(
      [...this.#devPlayers.values()].map((player) => [key(player.id), player]),
    );
    const players = this.#simulation.players.views().map((player) => ({
      ...player,
      control: controllers.has(key(player.id)) ? ("mcp" as const) : ("network" as const),
      controllerId: controllers.get(key(player.id))?.controllerId ?? null,
      connected: controllers.has(key(player.id)) || connected.has(key(player.id)),
      intent: controllers.has(key(player.id))
        ? {
            moveX: controllers.get(key(player.id))!.moveX,
            moveZ: controllers.get(key(player.id))!.moveZ,
            lookYaw: controllers.get(key(player.id))!.lookYaw,
            lookPitch: controllers.get(key(player.id))!.lookPitch,
            crouch: Boolean(controllers.get(key(player.id))!.buttons & 4),
            stopAtTick: controllers.get(key(player.id))!.stopAtTick,
          }
        : null,
    }));
    return {
      mapRevision: this.#bundle.mapRevision,
      worldEpoch: this.#worldEpoch,
      serverTick: this.#serverTick,
      gravity: { ...this.#bundle.settings.gravity },
      players,
      bodies: this.#runtimeBodies.map((body) => ({
        entityIndex: body.entityIndex,
        authoredId: body.authoredId,
        kind: this.#bundle.entities[body.entityIndex]?.kind ?? "unknown",
        ephemeral: this.#devBodyKeys.has(key(body.id)),
        ...this.#physics.state(body.handle),
      })),
    };
  }

  devPropArchetypes() {
    return this.#bundle.entities.flatMap((entity, entityIndex) => {
      if (entity.kind !== "physics-prop") return [];
      const vertices = entity.body.brushIndices.flatMap(
        (brushIndex) => this.#bundle.brushes[brushIndex]?.localVertices ?? [],
      );
      const bounds = vertices.reduce(
        (value, vertex) => ({
          min: {
            x: Math.min(value.min.x, vertex.x),
            y: Math.min(value.min.y, vertex.y),
            z: Math.min(value.min.z, vertex.z),
          },
          max: {
            x: Math.max(value.max.x, vertex.x),
            y: Math.max(value.max.y, vertex.y),
            z: Math.max(value.max.z, vertex.z),
          },
        }),
        {
          min: {
            x: Number.POSITIVE_INFINITY,
            y: Number.POSITIVE_INFINITY,
            z: Number.POSITIVE_INFINITY,
          },
          max: {
            x: Number.NEGATIVE_INFINITY,
            y: Number.NEGATIVE_INFINITY,
            z: Number.NEGATIVE_INFINITY,
          },
        },
      );
      return [
        {
          entityIndex,
          authoredId: entity.authoredId,
          density: entity.body.density,
          friction: entity.body.friction,
          restitution: entity.body.restitution,
          bounds,
        },
      ];
    });
  }

  spawnDevProp(entityIndex: number, position: Vec3, yaw = 0): RuntimeBody {
    if (this.#devBodyKeys.size >= MAX_DEV_PROPS)
      throw new Error(`dev prop limit of ${MAX_DEV_PROPS} reached`);
    assertFiniteVec3(position, "dev prop position");
    if (!Number.isFinite(yaw)) throw new Error("dev prop yaw must be finite");
    const authoredId = `dev.mcp.prop.${this.#devBodySequence++}`;
    const body = createRuntimeProp(
      this.#physics,
      this.#bundle,
      entityIndex,
      position,
      yawRotation(yaw),
      authoredId,
    );
    this.#runtimeBodies.push(body);
    this.#devBodyKeys.add(key(body.id));
    return body;
  }

  removeDevProp(id: RuntimeId): boolean {
    const identity = key(id);
    if (!this.#devBodyKeys.delete(identity)) return false;
    const index = this.#runtimeBodies.findIndex((body) => key(body.id) === identity);
    const body = this.#runtimeBodies[index];
    if (!body) return false;
    this.#physics.destroy(body.handle);
    this.#runtimeBodies.splice(index, 1);
    return true;
  }

  spawnDevPlayer(position?: Vec3, yaw?: number): { controllerId: string; id: RuntimeId } {
    if (this.#devPlayers.size >= MAX_DEV_PLAYERS)
      throw new Error(`dev player limit of ${MAX_DEV_PLAYERS} reached`);
    const spawn = this.#bundle.playerSpawns.find((candidate) => candidate.name === "default");
    if (!spawn) throw new Error("map requires a default player spawn");
    const initialPosition = position
      ? { ...position }
      : this.#playerSpawn
        ? { ...this.#playerSpawn }
        : {
            x: spawn.position.x,
            y: spawn.position.y + PLAYER_HALF_HEIGHT,
            z: spawn.position.z,
          };
    const initialYaw = yaw ?? spawn.yaw;
    assertFiniteVec3(initialPosition, "dev player position");
    if (!Number.isFinite(initialYaw)) throw new Error("dev player yaw must be finite");
    const controllerId = crypto.randomUUID();
    const id = this.#simulation.players.connect(`${DEV_PLAYER_PREFIX}${controllerId}`, {
      position: initialPosition,
      yaw: initialYaw,
    });
    this.#devPlayers.set(controllerId, {
      controllerId,
      id,
      sequence: 0,
      moveX: 0,
      moveZ: 0,
      lookYaw: initialYaw,
      lookPitch: 0,
      buttons: 0,
      jumpCounter: 0,
      interactCounter: 0,
      interactTarget: null,
      primaryCounter: 0,
      stopAtTick: null,
    });
    return { controllerId, id: { ...id } };
  }

  setDevPlayerIntent(controllerId: string, update: DevPlayerIntentUpdate) {
    const player = this.#devPlayers.get(controllerId);
    if (!player) throw new Error("unknown MCP player controller");
    if (
      update.durationSeconds !== undefined &&
      (!Number.isFinite(update.durationSeconds) ||
        update.durationSeconds < 0 ||
        update.durationSeconds > 5)
    )
      throw new Error("durationSeconds must be between 0 and 5");
    if (update.moveX !== undefined) player.moveX = clampUnit(update.moveX, "moveX");
    if (update.moveZ !== undefined) player.moveZ = clampUnit(update.moveZ, "moveZ");
    if (update.lookYaw !== undefined) {
      if (!Number.isFinite(update.lookYaw)) throw new Error("lookYaw must be finite");
      player.lookYaw = update.lookYaw;
    }
    if (update.lookPitch !== undefined) {
      if (!Number.isFinite(update.lookPitch)) throw new Error("lookPitch must be finite");
      player.lookPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, update.lookPitch));
    }
    if (update.crouch !== undefined)
      player.buttons = update.crouch ? player.buttons | 4 : player.buttons & ~4;
    if (update.action === "jump") player.jumpCounter = nextCounter(player.jumpCounter);
    if (update.action === "primary") player.primaryCounter = nextCounter(player.primaryCounter);
    if (update.action === "interact") {
      player.interactTarget = update.interactTarget ?? null;
      player.interactCounter = nextCounter(player.interactCounter);
    } else if (update.interactTarget !== undefined) {
      player.interactTarget = update.interactTarget ? { ...update.interactTarget } : null;
    }
    if (update.durationSeconds !== undefined) {
      player.stopAtTick =
        update.durationSeconds === 0
          ? this.#serverTick
          : this.#serverTick + Math.ceil(update.durationSeconds * PHYSICS_HZ);
    }
    return this.devWorldState().players.find((view) => key(view.id) === key(player.id)) ?? null;
  }

  stopDevPlayer(controllerId: string) {
    return this.setDevPlayerIntent(controllerId, {
      moveX: 0,
      moveZ: 0,
      crouch: false,
    });
  }

  removeDevPlayer(controllerId: string): RuntimeId | null {
    const player = this.#devPlayers.get(controllerId);
    if (!player) return null;
    this.#devPlayers.delete(controllerId);
    if (!this.#simulation.players.disconnect(player.id, { persist: false })) return null;
    return { ...player.id };
  }

  devRaycast(origin: Vec3, displacement: Vec3) {
    assertFiniteVec3(origin, "ray origin");
    assertFiniteVec3(displacement, "ray displacement");
    if (Math.hypot(displacement.x, displacement.y, displacement.z) > 1_000)
      throw new Error("ray displacement must be at most 1000 metres");
    const hit = this.#physics.raycastClosest(origin, displacement);
    return hit
      ? {
          body: { ...hit.body },
          point: { ...hit.point },
          normal: { ...hit.normal },
          fraction: hit.fraction,
        }
      : null;
  }

  start(): void {
    if (this.#timer) return;
    this.#lastTime = performance.now();
    this.#timer = setInterval(() => {
      const now = performance.now();
      this.advance((now - this.#lastTime) / 1_000);
      this.#lastTime = now;
    }, 4);
  }

  advance(elapsedSeconds: number): void {
    const accumulated = this.#accumulator + Math.max(0, elapsedSeconds);
    const maximum = PHYSICS_DT * MAX_CATCH_UP_TICKS;
    if (accumulated > maximum) this.#discardedOverloadSeconds += accumulated - maximum;
    this.#accumulator = Math.min(accumulated, maximum);
    let steps = 0;
    while (this.#accumulator >= PHYSICS_DT && steps < MAX_CATCH_UP_TICKS) {
      const tickStartedAt = performance.now();
      this.#submitDevPlayerInputs();
      this.#simulation.step();
      const events = this.#physics.step(PHYSICS_DT, PHYSICS_SUBSTEPS);
      this.#processPostPhysics(events);
      this.#serverTick += 1;
      this.#accumulator -= PHYSICS_DT;
      steps += 1;
      if (this.#serverTick % SNAPSHOT_INTERVAL_TICKS === 0) this.#onSnapshot(this.snapshot());
      if (this.#saveRequested) {
        this.#saveRequested = false;
        this.save();
      }
      if (this.#serverTick % SAVE_INTERVAL_TICKS === 0) this.save();
      this.#tickDurationsMs.push(performance.now() - tickStartedAt);
      if (this.#tickDurationsMs.length > 1_200) this.#tickDurationsMs.shift();
    }
  }

  snapshot(): Snapshot {
    const players = this.#simulation.players.views();
    const bodies = this.#runtimeBodies.map(({ handle }) => {
      const identity = key(handle);
      const grabbed = players.some(
        (player) => player.grabTarget && key(player.grabTarget) === identity,
      );
      const { awake: _awake, ...state } = this.#physics.state(handle);
      return {
        ...state,
        flags: grabbed ? SNAPSHOT_FLAG_GRABBED : 0,
      };
    });
    return {
      worldEpoch: this.#worldEpoch,
      serverTick: this.#serverTick,
      bodies: bodies.concat(
        players.map((player) => ({
          id: player.id,
          position: player.position,
          rotation: yawRotation(player.yaw),
          linearVelocity: { x: 0, y: player.verticalVelocity, z: 0 },
          angularVelocity: { x: 0, y: 0, z: 0 },
          flags: 0,
        })),
      ),
      players: players.map((player) => ({
        id: player.id,
        position: player.position,
        yaw: player.yaw,
        verticalVelocity: player.verticalVelocity,
        grounded: player.grounded,
        lastProcessedInputSequence: player.lastProcessedInputSequence,
        lastJumpCounter: player.lastJumpCounter,
        stepCooldown: player.stepCooldown,
        crouched: player.crouched,
      })),
    };
  }

  worldMessage(): WorldMessage {
    return {
      type: "world",
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: this.#worldEpoch,
      bundle: this.#bundle,
      runtimeEntities: [
        ...this.#runtimeBodies.map(runtimeBodyRef),
        ...this.#simulation.players.runtimeRefs(),
      ],
    };
  }

  grabbedTarget(playerId: RuntimeId): RuntimeId | null {
    return this.#simulation.players.grabbedTarget(playerId);
  }

  reset(): Snapshot {
    this.#clearDevPlayers();
    this.#physics.recreate();
    this.#physics.createStaticMesh({
      vertices: this.#bundle.staticCollision.vertices,
      triangles: this.#bundle.staticCollision.triangles,
    });
    this.#runtimeBodies = [];
    this.#saveRequested = false;
    this.#devBodyKeys.clear();
    this.#worldEpoch += 1;
    this.#serverTick = 0;
    this.#accumulator = 0;
    this.#runtimeBodies = createRuntimeBodies(
      this.#physics,
      this.#bundle,
      null,
      this.#extraDynamicBodyCount,
    );
    this.#simulation.reset();
    this.save();
    this.#onWorld(this.worldMessage());
    const snapshot = this.snapshot();
    this.#onSnapshot(snapshot);
    return snapshot;
  }

  save(): void {
    this.#store.save(this.#bundle.mapRevision, {
      worldEpoch: this.#worldEpoch,
      serverTick: this.#serverTick,
      bodies: this.#runtimeBodies
        .filter((body) => !this.#devBodyKeys.has(key(body.id)))
        .map((body) => ({
          authoredId: body.authoredId,
          ...this.#physics.state(body.handle),
        })),
      gameState: this.#simulation.persistedState(),
      players: this.#simulation.players
        .persisted()
        .filter((player) => !player.persistentId.startsWith(DEV_PLAYER_PREFIX)),
    });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#clearDevPlayers();
    this.save();
    this.#physics.dispose();
  }

  #createGameSimulation(restored: PersistedWorld | null): GameSimulation {
    return createGameSimulation({
      engine: this.#gameEngine(),
      bundle: this.#bundle,
      restored: restored?.gameState ?? null,
      players: {
        restored: restored?.players ?? [],
        ...(this.#playerSpawn ? { spawnPosition: this.#playerSpawn } : {}),
        stepController: (state, input) =>
          stepPlayerController(
            this.#physics,
            state,
            input,
            PHYSICS_DT,
            Math.max(0, -this.#bundle.settings.gravity.y),
          ),
      },
    });
  }

  #gameEngine(): GameEngine {
    const tick = (): number => this.#serverTick;
    return {
      get tick() {
        return tick();
      },
      dt: PHYSICS_DT,
      bodies: {
        forEntity: (entityIndex) => {
          const body = this.#runtimeBodies.find(
            (candidate) => candidate.entityIndex === entityIndex,
          );
          return body ? { id: body.handle, entityIndex: body.entityIndex } : null;
        },
        resolve: (id) => {
          const body = this.#runtimeBodies.find((candidate) => key(candidate.handle) === key(id));
          return body ? { id: body.handle, entityIndex: body.entityIndex } : null;
        },
        state: (id) => this.#physics.state(id),
      },
      setKinematicTarget: (id, position) =>
        this.#physics.setKinematicTarget(id, position, PHYSICS_DT),
      setBodyAwake: (id, awake) => this.#physics.setBodyAwake(id, awake),
      raycast: (origin, displacement, options) =>
        this.#physics.raycastClosest(origin, displacement, options),
      createPlayerProxy: (position, shape) => this.#physics.createPlayerProxy(position, shape),
      updatePlayerProxy: (id, position, yaw) =>
        this.#physics.setBodyTransform(id, position, yawRotation(yaw)),
      destroyBody: (id) => {
        this.#physics.destroy(id);
      },
      driveBodyToTarget: (id, options) =>
        this.#physics.driveBodyToTarget(id, { ...options, seconds: PHYSICS_DT }),
      requestSave: () => {
        this.#saveRequested = true;
      },
    };
  }

  #processPostPhysics(events: PhysicsStepEvents): void {
    this.#simulation.processSensorEvents(events.sensorBegin, events.sensorEnd);
  }

  #submitDevPlayerInputs(): void {
    for (const player of this.#devPlayers.values()) {
      if (player.stopAtTick !== null && this.#serverTick >= player.stopAtTick) {
        player.moveX = 0;
        player.moveZ = 0;
        player.buttons &= ~4;
        player.stopAtTick = null;
      }
      const command: InputCommand = {
        type: "input",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: this.#worldEpoch,
        sequence: player.sequence++,
        clientTick: this.#serverTick,
        moveX: player.moveX,
        moveZ: player.moveZ,
        lookYaw: player.lookYaw,
        lookPitch: player.lookPitch,
        buttons: player.buttons,
        jumpCounter: player.jumpCounter,
        interactCounter: player.interactCounter,
        interactTarget: player.interactTarget ? { ...player.interactTarget } : null,
        primaryCounter: player.primaryCounter,
      };
      this.#simulation.players.acceptInput(player.id, command, this.#worldEpoch);
    }
  }

  #clearDevPlayers(): void {
    for (const controllerId of this.#devPlayers.keys()) this.removeDevPlayer(controllerId);
  }
}

function yawRotation(yaw: number): Quat {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function assertFiniteVec3(value: Vec3, label: string): void {
  if (![value.x, value.y, value.z].every(Number.isFinite))
    throw new Error(`${label} must contain finite coordinates`);
}

function clampUnit(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return Math.max(-1, Math.min(1, value));
}

function nextCounter(value: number): number {
  return (value + 1) >>> 0;
}

function key(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}
