import { PhysicsWorld, type PhysicsStepEvents } from "@gurgur/engine";
import {
  createGameSimulation,
  stepPlayerController,
  type GameEngine,
  type GameSimulation,
  type WorldBundle,
  type WorldMessage,
} from "@gurgur/game";
import {
  FAR_BODY_SNAPSHOT_STRIDE,
  FULL_RATE_BODY_RADIUS_METRES,
  MAX_CATCH_UP_TICKS,
  PHYSICS_DT,
  PHYSICS_HZ,
  PHYSICS_SUBSTEPS,
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL_TICKS,
  SNAPSHOT_FLAG_CREATED,
  SNAPSHOT_FLAG_GRABBED,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_TELEPORT,
  SNAPSHOT_FLAG_WAKE,
  type InputCommand,
  type PhysicsDebugFrame,
  type RuntimeId,
  type Snapshot,
  type Vec3,
} from "@gurgur/engine";
import { createRuntimeBodies, runtimeBodyRef, type RuntimeBody } from "./runtime-bodies";
import type { PersistedWorld, WorldStore } from "./store";
import { WORLD_BUNDLE } from "./world";

const SAVE_INTERVAL_TICKS = 5 / PHYSICS_DT;
const TERMINAL_BODY_REPEAT_TICKS = PHYSICS_HZ;
const DISCONTINUITY_REPEAT_TICKS = PHYSICS_HZ;
export class AuthoritativeGame {
  readonly #physics: PhysicsWorld;
  readonly #bundle: WorldBundle;
  readonly #store: WorldStore;
  readonly #onSnapshot: (snapshot: Snapshot) => void;
  readonly #onWorld: (world: WorldMessage) => void;
  #runtimeBodies: RuntimeBody[] = [];
  #simulation!: GameSimulation;
  #saveRequested = false;
  readonly #replicationState = new Map<string, { position: Vec3; awake: boolean }>();
  readonly #dirtyBodies = new Set<string>();
  readonly #terminalBodyRepeatUntilTick = new Map<string, number>();
  readonly #discontinuityRepeatUntilTick = new Map<string, number>();
  readonly #tickDurationsMs: number[] = [];
  #discardedOverloadSeconds = 0;
  #worldEpoch: number;
  #serverTick: number;
  #accumulator = 0;
  #lastTime = 0;
  #timer: Timer | null = null;
  readonly #playerSpawn: Vec3 | null;
  #extraDynamicBodyCount = 0;

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
    for (const body of game.#runtimeBodies) game.#dirtyBodies.add(key(body.handle));
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
    if (!this.#simulation.players.disconnect(id)) return false;
    this.#replicationState.delete(key(id));
    this.#discontinuityRepeatUntilTick.delete(key(id));
    return true;
  }

  acceptInput(id: RuntimeId, command: InputCommand): boolean {
    return this.#simulation.players.acceptInput(id, command, this.#worldEpoch);
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
      this.#simulation.step();
      const events = this.#physics.step(PHYSICS_DT, PHYSICS_SUBSTEPS);
      this.#processPostPhysics(events);
      this.#serverTick += 1;
      this.#accumulator -= PHYSICS_DT;
      steps += 1;
      if (this.#serverTick % SNAPSHOT_INTERVAL_TICKS === 0)
        this.#onSnapshot(this.snapshot({ full: false }));
      if (this.#saveRequested) {
        this.#saveRequested = false;
        this.save();
      }
      if (this.#serverTick % SAVE_INTERVAL_TICKS === 0) this.save();
      this.#tickDurationsMs.push(performance.now() - tickStartedAt);
      if (this.#tickDurationsMs.length > 1_200) this.#tickDurationsMs.shift();
    }
  }

  snapshot(options: { full?: boolean; discontinuity?: boolean } = { full: true }): Snapshot {
    const full = options.full !== false;
    const discontinuity = options.discontinuity === true;
    const players = this.#simulation.players.views();
    const snapshotIndex = Math.floor(this.#serverTick / SNAPSHOT_INTERVAL_TICKS);
    const bodies = this.#runtimeBodies.flatMap(({ handle }) => {
      const identity = key(handle);
      const grabbed = players.some(
        (player) => player.grabTarget && key(player.grabTarget) === identity,
      );
      const { awake, ...state } = this.#physics.state(handle);
      const predictionRelevant = players.some(
        (player) => distance(player.position, state.position) <= FULL_RATE_BODY_RADIUS_METRES,
      );
      const repeatUntil = this.#terminalBodyRepeatUntilTick.get(identity) ?? -1;
      const repeatTerminalState = repeatUntil >= this.#serverTick;
      if (repeatUntil >= 0 && !repeatTerminalState)
        this.#terminalBodyRepeatUntilTick.delete(identity);
      const remoteBodyDue = (snapshotIndex + handle.index) % FAR_BODY_SNAPSHOT_STRIDE === 0;
      if (
        !full &&
        !predictionRelevant &&
        !repeatTerminalState &&
        (!this.#dirtyBodies.has(identity) || !remoteBodyDue)
      )
        return [];
      if (!full) this.#dirtyBodies.delete(identity);
      return [
        {
          ...state,
          flags:
            (discontinuity
              ? SNAPSHOT_FLAG_TELEPORT
              : this.#snapshotFlags(handle, state.position, awake)) |
            (!awake && (full || repeatTerminalState) ? SNAPSHOT_FLAG_SLEEP : 0) |
            (grabbed ? SNAPSHOT_FLAG_GRABBED : 0),
        },
      ];
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
          flags: discontinuity
            ? SNAPSHOT_FLAG_TELEPORT
            : this.#snapshotFlags(player.id, player.position, true),
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
    this.#physics.recreate();
    this.#physics.createStaticMesh({
      vertices: this.#bundle.staticCollision.vertices,
      triangles: this.#bundle.staticCollision.triangles,
    });
    this.#runtimeBodies = [];
    this.#saveRequested = false;
    this.#replicationState.clear();
    this.#dirtyBodies.clear();
    this.#terminalBodyRepeatUntilTick.clear();
    this.#discontinuityRepeatUntilTick.clear();
    this.#worldEpoch += 1;
    this.#serverTick = 0;
    this.#accumulator = 0;
    this.#runtimeBodies = createRuntimeBodies(
      this.#physics,
      this.#bundle,
      null,
      this.#extraDynamicBodyCount,
    );
    for (const body of this.#runtimeBodies) this.#dirtyBodies.add(key(body.handle));
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
      bodies: this.#runtimeBodies.map((body) => ({
        authoredId: body.authoredId,
        ...this.#physics.state(body.handle),
      })),
      gameState: this.#simulation.persistedState(),
      players: this.#simulation.players.persisted(),
    });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
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
      raycast: (origin, displacement) => this.#physics.raycastClosest(origin, displacement),
      createPlayerProxy: (position, shape) => this.#physics.createPlayerProxy(position, shape),
      updatePlayerProxy: (id, position, yaw) =>
        this.#physics.setBodyTransform(id, position, yawRotation(yaw)),
      destroyBody: (id) => {
        this.#physics.destroy(id);
      },
      createGrabConstraint: (options) => this.#physics.createDistanceConstraint(options),
      destroyConstraint: (id) => {
        this.#physics.destroyConstraint(id);
      },
      requestSave: () => {
        this.#saveRequested = true;
      },
    };
  }

  #processPostPhysics(events: PhysicsStepEvents): void {
    for (const event of events.moved) {
      const identity = key(event.body);
      this.#dirtyBodies.add(identity);
      if (event.fellAsleep)
        this.#terminalBodyRepeatUntilTick.set(
          identity,
          this.#serverTick + TERMINAL_BODY_REPEAT_TICKS,
        );
    }
    this.#simulation.processSensorBegins(events.sensorBegin);
  }

  #snapshotFlags(id: RuntimeId, position: Vec3, awake: boolean): number {
    const identity = key(id);
    const previous = this.#replicationState.get(identity);
    let flags = previous ? 0 : SNAPSHOT_FLAG_CREATED;
    if (previous) {
      if (!previous.awake && awake) flags |= SNAPSHOT_FLAG_WAKE;
      if (previous.awake && !awake) flags |= SNAPSHOT_FLAG_SLEEP;
      if (
        Math.hypot(
          position.x - previous.position.x,
          position.y - previous.position.y,
          position.z - previous.position.z,
        ) >= 2
      ) {
        flags |= SNAPSHOT_FLAG_TELEPORT;
        this.#discontinuityRepeatUntilTick.set(
          identity,
          this.#serverTick + DISCONTINUITY_REPEAT_TICKS,
        );
      }
    }
    const repeatUntil = this.#discontinuityRepeatUntilTick.get(identity) ?? -1;
    if (repeatUntil >= this.#serverTick) flags |= SNAPSHOT_FLAG_TELEPORT;
    else if (repeatUntil >= 0) this.#discontinuityRepeatUntilTick.delete(identity);
    this.#replicationState.set(identity, { position: { ...position }, awake });
    return flags;
  }
}

function yawRotation(yaw: number) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function key(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
