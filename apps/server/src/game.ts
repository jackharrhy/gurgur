import {
  PLAYER_HALF_HEIGHT,
  PhysicsWorld,
  stepPlayerController,
  type ConstraintId,
  type PhysicsStepEvents,
  type PlayerControllerState,
} from "@gurgur/physics";
import {
  MAX_CATCH_UP_TICKS,
  INPUT_INTENT_TIMEOUT_TICKS,
  LOCAL_PHYSICS_RADIUS_METRES,
  PHYSICS_DT,
  PHYSICS_SUBSTEPS,
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL_TICKS,
  SNAPSHOT_FLAG_CREATED,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_TELEPORT,
  SNAPSHOT_FLAG_WAKE,
  type InputCommand,
  type RuntimeId,
  type Snapshot,
  type Vec3,
  type WorldBundle,
  type WorldMessage,
} from "@gurgur/shared";
import { createMechanismRuntime, type MechanismRuntime } from "./mechanisms";
import { createRuntimeBodies, type RuntimeBody } from "./runtime-bodies";
import type { PersistedWorld, WorldStore } from "./store";
import { WORLD_BUNDLE } from "./world";

const SAVE_INTERVAL_TICKS = 5 / PHYSICS_DT;
const PLAYER_INDEX_BASE = 0x8000_0000;
type Player = {
  id: RuntimeId;
  persistentId: string;
  proxy: RuntimeId;
  state: PlayerControllerState;
  input: Pick<InputCommand, "moveX" | "moveZ" | "lookYaw" | "lookPitch" | "buttons" | "jumpCounter" | "interactCounter" | "interactTarget" | "primaryCounter">;
  pendingInputs: Array<Pick<InputCommand, "sequence" | "moveX" | "moveZ" | "lookYaw" | "lookPitch" | "buttons" | "jumpCounter" | "interactCounter" | "interactTarget" | "primaryCounter">>;
  lastSequence: number;
  lastProcessedInputSequence: number;
  lastInputServerTick: number;
  lastInteractCounter: number;
  lastPrimaryCounter: number;
  grab: { constraint: ConstraintId; target: RuntimeId; length: number } | null;
};
type PlayerSlot = { generation: number; player: Player | null };
export class AuthoritativeGame {
  readonly #physics: PhysicsWorld;
  readonly #bundle: WorldBundle;
  readonly #store: WorldStore;
  readonly #onSnapshot: (snapshot: Snapshot) => void;
  readonly #onWorld: (world: WorldMessage) => void;
  #runtimeBodies: RuntimeBody[] = [];
  #mechanismRuntime!: MechanismRuntime;
  #saveRequested = false;
  readonly #replicationState = new Map<string, { position: Vec3; awake: boolean }>();
  readonly #dirtyBodies = new Set<string>();
  readonly #tickDurationsMs: number[] = [];
  #discardedOverloadSeconds = 0;
  readonly #playerSlots: PlayerSlot[] = [];
  readonly #freePlayerSlots: number[] = [];
  readonly #dormantPlayers = new Map<string, PersistedWorld["players"][number]>();
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
    this.#playerSpawn = playerSpawn;
  }

  static async create(
    store: WorldStore,
    onSnapshot: (snapshot: Snapshot) => void,
    onWorld: (world: WorldMessage) => void,
    options: { playerSpawn?: Vec3; extraDynamicBodies?: number; worldBundle?: WorldBundle } = {},
  ): Promise<AuthoritativeGame> {
    const bundle = options.worldBundle ?? WORLD_BUNDLE;
    const physics = await PhysicsWorld.create();
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
    game.#runtimeBodies = createRuntimeBodies(physics, bundle, restored, game.#extraDynamicBodyCount);
    for (const body of game.#runtimeBodies) game.#dirtyBodies.add(key(body.handle));
    game.#mechanismRuntime = game.#createMechanismRuntime(restored);
    for (const player of restored?.players ?? []) game.#dormantPlayers.set(player.persistentId, structuredClone(player));
    return game;
  }

  get worldEpoch(): number { return this.#worldEpoch; }
  get serverTick(): number { return this.#serverTick; }
  get mapRevision(): string { return this.#bundle.mapRevision; }
  playerPosition(id: RuntimeId): Vec3 | null {
    return this.#resolvePlayer(id)?.player.state.position ?? null;
  }
  beginInputStream(id: RuntimeId): boolean {
    const resolved = this.#resolvePlayer(id);
    if (!resolved) return false;
    resolved.player.pendingInputs.length = 0;
    resolved.player.lastSequence = -1;
    resolved.player.lastProcessedInputSequence = -1;
    resolved.player.lastInputServerTick = this.#serverTick;
    resolved.player.input = { ...resolved.player.input, moveX: 0, moveZ: 0, buttons: 0 };
    return true;
  }
  metrics(): { tickP95Ms: number; tickP99Ms: number; tickMaxMs: number; discardedOverloadSeconds: number } {
    const sorted = [...this.#tickDurationsMs].sort((a, b) => a - b);
    const percentile = (amount: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))] ?? 0;
    return {
      tickP95Ms: percentile(0.95), tickP99Ms: percentile(0.99), tickMaxMs: sorted.at(-1) ?? 0,
      discardedOverloadSeconds: this.#discardedOverloadSeconds,
    };
  }

  canResumePlayer(persistentId: string): boolean {
    return this.#dormantPlayers.has(persistentId);
  }

  connectPlayer(persistentId: string = crypto.randomUUID()): RuntimeId {
    if (this.#players().some((player) => player.persistentId === persistentId)) {
      throw new Error("persistent player identity is already connected");
    }
    const slotIndex = this.#freePlayerSlots.pop() ?? this.#playerSlots.length;
    const existing = this.#playerSlots[slotIndex];
    const generation = existing?.generation ?? 1;
    const id = { index: PLAYER_INDEX_BASE + slotIndex, generation };
    const restored = this.#dormantPlayers.get(persistentId);
    this.#dormantPlayers.delete(persistentId);
    this.#playerSlots[slotIndex] = { generation, player: this.#newPlayer(id, persistentId, restored) };
    return id;
  }

  disconnectPlayer(id: RuntimeId): boolean {
    const resolved = this.#resolvePlayer(id);
    if (!resolved) return false;
    if (resolved.player.grab) this.#physics.destroyConstraint(resolved.player.grab.constraint);
    this.#dormantPlayers.set(resolved.player.persistentId, this.#persistPlayer(resolved.player));
    this.#physics.destroy(resolved.player.proxy);
    this.#replicationState.delete(key(id));
    resolved.slot.player = null;
    resolved.slot.generation += 1;
    this.#freePlayerSlots.push(resolved.slotIndex);
    this.#saveRequested = true;
    return true;
  }

  acceptInput(id: RuntimeId, command: InputCommand): boolean {
    const resolved = this.#resolvePlayer(id);
    if (!resolved) return false;
    if (command.worldEpoch !== this.#worldEpoch || command.sequence <= resolved.player.lastSequence) return true;
    if (resolved.player.pendingInputs.length >= 120) resolved.player.pendingInputs.length = 0;
    resolved.player.lastSequence = command.sequence;
    resolved.player.pendingInputs.push({
      sequence: command.sequence,
      moveX: clamp(command.moveX, -1, 1),
      moveZ: clamp(command.moveZ, -1, 1),
      lookYaw: command.lookYaw,
      lookPitch: command.lookPitch,
      buttons: command.buttons,
      jumpCounter: command.jumpCounter,
      interactCounter: command.interactCounter,
      interactTarget: command.interactTarget ? { ...command.interactTarget } : null,
      primaryCounter: command.primaryCounter,
    });
    return true;
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
      this.#mechanismRuntime.step();
      this.#stepPlayers();
      const events = this.#physics.step(PHYSICS_DT, PHYSICS_SUBSTEPS);
      this.#processPostPhysics(events);
      this.#serverTick += 1;
      this.#accumulator -= PHYSICS_DT;
      steps += 1;
      if (this.#serverTick % SNAPSHOT_INTERVAL_TICKS === 0) this.#onSnapshot(this.snapshot({ full: false }));
      if (this.#saveRequested) {
        this.#saveRequested = false;
        this.save();
      }
      if (this.#serverTick % SAVE_INTERVAL_TICKS === 0) this.save();
      this.#tickDurationsMs.push(performance.now() - tickStartedAt);
      if (this.#tickDurationsMs.length > 1_200) this.#tickDurationsMs.shift();
    }
  }

  snapshot(options: { full?: boolean } = { full: true }): Snapshot {
    const full = options.full !== false;
    const players = this.#players();
    const bodies = this.#runtimeBodies.flatMap(({ handle }) => {
      const identity = key(handle);
      const { awake, ...state } = this.#physics.state(handle);
      const predictionRelevant = players.some((player) => distance(player.state.position, state.position) <= LOCAL_PHYSICS_RADIUS_METRES);
      if (!full && !this.#dirtyBodies.has(identity) && !predictionRelevant) return [];
      return [{ ...state, flags: this.#snapshotFlags(handle, state.position, awake) }];
    });
    if (!full) this.#dirtyBodies.clear();
    return {
      worldEpoch: this.#worldEpoch,
      serverTick: this.#serverTick,
      bodies: bodies.concat(players.map((player) => ({
        id: player.id,
        position: player.state.position,
        rotation: yawRotation(player.state.yaw),
        linearVelocity: { x: 0, y: player.state.verticalVelocity, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        flags: this.#snapshotFlags(player.id, player.state.position, true),
      }))),
      players: players.map((player) => ({
        id: player.id,
        position: player.state.position,
        yaw: player.state.yaw,
        verticalVelocity: player.state.verticalVelocity,
        grounded: player.state.grounded,
        lastProcessedInputSequence: player.lastProcessedInputSequence,
        lastJumpCounter: player.state.lastJumpCounter,
        stepCooldown: player.state.stepCooldown,
        crouched: player.state.crouched,
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
        ...this.#runtimeBodies.map(({ handle, ...runtime }) => ({ ...runtime, id: handle })),
        ...this.#players().map((player) => ({
          id: player.id,
          authoredId: `player.${player.id.index}`,
          classname: "player" as const,
        })),
      ],
    };
  }

  reset(): Snapshot {
    this.#physics.recreate();
    this.#physics.createStaticMesh({
      vertices: this.#bundle.staticCollision.vertices,
      triangles: this.#bundle.staticCollision.triangles,
    });
    this.#runtimeBodies = [];
    this.#dormantPlayers.clear();
    this.#saveRequested = false;
    this.#replicationState.clear();
    this.#dirtyBodies.clear();
    this.#worldEpoch += 1;
    this.#serverTick = 0;
    this.#accumulator = 0;
    this.#runtimeBodies = createRuntimeBodies(this.#physics, this.#bundle, null, this.#extraDynamicBodyCount);
    for (const body of this.#runtimeBodies) this.#dirtyBodies.add(key(body.handle));
    this.#mechanismRuntime = this.#createMechanismRuntime(null);
    for (const player of this.#players()) {
      const replacement = this.#newPlayer(player.id, player.persistentId);
      player.proxy = replacement.proxy;
      player.state = replacement.state;
      player.input = replacement.input;
      player.pendingInputs = replacement.pendingInputs;
      player.lastSequence = replacement.lastSequence;
      player.lastProcessedInputSequence = replacement.lastProcessedInputSequence;
      player.lastInputServerTick = replacement.lastInputServerTick;
      player.lastInteractCounter = replacement.lastInteractCounter;
      player.lastPrimaryCounter = replacement.lastPrimaryCounter;
      player.grab = replacement.grab;
    }
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
      mechanisms: this.#mechanismRuntime.mechanisms.map((mechanism) => ({
        authoredId: mechanism.authoredId,
        progress: mechanism.progress,
        direction: mechanism.direction,
        resumeAtTick: mechanism.resumeAtTick,
      })),
      signals: [
        ...this.#mechanismRuntime.triggers.map((trigger) => ({
          authoredId: trigger.authoredId,
          kind: "trigger" as const,
          readyAtTick: trigger.readyAtTick,
          latched: trigger.consumed,
        })),
        ...this.#mechanismRuntime.relays.map((relay) => ({
          authoredId: relay.authoredId,
          kind: "relay" as const,
          readyAtTick: 0,
          latched: relay.fired,
        })),
        ...this.#mechanismRuntime.buttons.map((button) => ({
          authoredId: button.authoredId,
          kind: "button" as const,
          readyAtTick: button.readyAtTick,
          latched: false,
        })),
      ],
      delayedSignals: this.#mechanismRuntime.delayedSignals.map((signal) => ({ ...signal })),
      players: [
        ...this.#players().map((player) => this.#persistPlayer(player)),
        ...this.#dormantPlayers.values(),
      ],
    });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.save();
    this.#physics.dispose();
  }

  #createMechanismRuntime(restored: PersistedWorld | null): MechanismRuntime {
    return createMechanismRuntime({
      physics: this.#physics,
      bundle: this.#bundle,
      bodies: this.#runtimeBodies,
      restored,
      currentTick: () => this.#serverTick,
      playerProxies: () => this.#players().map((player) => player.proxy),
      requestSave: () => { this.#saveRequested = true; },
    });
  }

  #processPostPhysics(events: PhysicsStepEvents): void {
    for (const event of events.moved) this.#dirtyBodies.add(key(event.body));
    this.#mechanismRuntime.processSensorBegins(events.sensorBegin);
  }

  #stepPlayers(): void {
    for (const player of this.#players()) {
      const coalescing = player.pendingInputs.length > 12;
      const pending = coalescing ? player.pendingInputs.pop() : player.pendingInputs.shift();
      if (pending) {
        if (coalescing) player.pendingInputs.length = 0;
        player.input = {
          moveX: pending.moveX,
          moveZ: pending.moveZ,
          lookYaw: pending.lookYaw,
          lookPitch: pending.lookPitch,
          buttons: pending.buttons,
          jumpCounter: pending.jumpCounter,
          interactCounter: pending.interactCounter,
          interactTarget: pending.interactTarget,
          primaryCounter: pending.primaryCounter,
        };
        player.lastProcessedInputSequence = pending.sequence;
        player.lastInputServerTick = this.#serverTick;
      } else if (this.#serverTick - player.lastInputServerTick >= INPUT_INTENT_TIMEOUT_TICKS) {
        player.input = { ...player.input, moveX: 0, moveZ: 0 };
      }
      const wasCrouched = player.state.crouched;
      player.state = stepPlayerController(this.#physics, player.state, player.input, PHYSICS_DT);
      if (player.state.crouched !== wasCrouched) {
        if (player.grab) {
          this.#physics.destroyConstraint(player.grab.constraint);
          player.grab = null;
        }
        this.#physics.destroy(player.proxy);
        player.proxy = this.#physics.createPlayerProxy(player.state.position, { crouched: player.state.crouched });
      } else {
        this.#physics.setBodyTransform(player.proxy, player.state.position, yawRotation(player.state.yaw));
      }
      if (player.input.interactCounter !== player.lastInteractCounter) {
        player.lastInteractCounter = player.input.interactCounter;
        this.#tryInteract(player, player.input.interactTarget);
      }
      if (player.input.primaryCounter !== player.lastPrimaryCounter) {
        player.lastPrimaryCounter = player.input.primaryCounter;
        this.#tryGrab(player, player.input.interactTarget);
      }
    }
  }

  #tryInteract(player: Player, target: RuntimeId | null): void {
    if (!target) return;
    const button = this.#mechanismRuntime.buttons.find((candidate) => key(candidate.handle) === key(target));
    if (!button || button.readyAtTick > this.#serverTick) return;
    const horizontal = Math.cos(player.input.lookPitch);
    const direction = {
      x: -Math.sin(player.input.lookYaw) * horizontal,
      y: Math.sin(player.input.lookPitch),
      z: -Math.cos(player.input.lookYaw) * horizontal,
    };
    const hit = this.#physics.raycastClosest(
      { x: player.state.position.x, y: player.state.position.y + 0.4, z: player.state.position.z },
      { x: direction.x * 3, y: direction.y * 3, z: direction.z * 3 },
    );
    if (!hit || key(hit.body) !== key(button.handle)) return;
    button.readyAtTick = this.#serverTick + button.waitTicks;
    this.#saveRequested = true;
    this.#mechanismRuntime.emitTarget(button.target);
  }

  #tryGrab(player: Player, target: RuntimeId | null): void {
    if (player.grab) {
      this.#physics.destroyConstraint(player.grab.constraint);
      player.grab = null;
      this.#saveRequested = true;
      return;
    }
    if (!target || this.#players().some((candidate) => candidate.grab && key(candidate.grab.target) === key(target))) return;
    const body = this.#runtimeBodies.find((candidate) => key(candidate.handle) === key(target) && candidate.classname === "func_physics");
    if (!body) return;
    const horizontal = Math.cos(player.input.lookPitch);
    const direction = {
      x: -Math.sin(player.input.lookYaw) * horizontal,
      y: Math.sin(player.input.lookPitch),
      z: -Math.cos(player.input.lookYaw) * horizontal,
    };
    const anchor = { x: player.state.position.x, y: player.state.position.y + 0.4, z: player.state.position.z };
    const hit = this.#physics.raycastClosest(anchor, {
      x: direction.x * 3, y: direction.y * 3, z: direction.z * 3,
    });
    if (!hit || key(hit.body) !== key(body.handle)) return;
    const length = Math.max(0.5, Math.hypot(hit.point.x - anchor.x, hit.point.y - anchor.y, hit.point.z - anchor.z));
    player.grab = {
      target: body.handle,
      length,
      constraint: this.#physics.createDistanceConstraint({
        bodyA: player.proxy, bodyB: body.handle,
        worldAnchorA: anchor, worldAnchorB: hit.point,
        length,
        hertz: 7, dampingRatio: 0.9, maxForce: 350,
      }),
    };
    this.#saveRequested = true;
  }

  #newPlayer(
    id: RuntimeId,
    persistentId: string,
    restored?: PersistedWorld["players"][number],
  ): Player {
    const spawn = this.#bundle.entities.find((entity) => entity.classname === "info_player_start")?.origin;
    if (!spawn) throw new Error("map requires an info_player_start");
    const yaw = Number(this.#bundle.entities.find((entity) => entity.classname === "info_player_start")?.runtimeProperties.angle ?? 0);
    const state: PlayerControllerState = restored ? {
      position: { ...restored.position },
      verticalVelocity: restored.verticalVelocity,
      yaw: restored.yaw,
      grounded: restored.grounded,
      lastJumpCounter: restored.lastJumpCounter,
      stepCooldown: restored.stepCooldown,
      crouched: restored.crouched,
    } : {
      position: this.#playerSpawn
        ? { ...this.#playerSpawn }
        : { x: spawn.x, y: spawn.y + PLAYER_HALF_HEIGHT, z: spawn.z },
      verticalVelocity: 0,
      yaw,
      grounded: false,
      lastJumpCounter: 0,
      stepCooldown: 0,
      crouched: false,
    };
    const player: Player = {
      id,
      persistentId,
      proxy: this.#physics.createPlayerProxy(state.position, { crouched: state.crouched }),
      state,
      input: {
        moveX: 0, moveZ: 0, lookYaw: yaw, lookPitch: 0, buttons: 0, jumpCounter: 0,
        interactCounter: 0, interactTarget: null,
        primaryCounter: 0,
      },
      pendingInputs: [],
      lastSequence: -1,
      lastProcessedInputSequence: -1,
      lastInputServerTick: this.#serverTick,
      lastInteractCounter: 0,
      lastPrimaryCounter: 0,
      grab: null,
    };
    if (restored?.grabbedAuthoredId) {
      const target = this.#runtimeBodies.find((body) => body.authoredId === restored.grabbedAuthoredId);
      const alreadyOwned = this.#players().some((candidate) => candidate.grab && target && key(candidate.grab.target) === key(target.handle));
      if (target && !alreadyOwned) {
        this.#physics.setBodyAwake(target.handle, true);
        const anchor = { x: state.position.x, y: state.position.y + 0.4, z: state.position.z };
        const targetPosition = this.#physics.state(target.handle).position;
        const length = Math.max(0.5, restored.grabLength);
        player.grab = {
          target: target.handle,
          length,
          constraint: this.#physics.createDistanceConstraint({
            bodyA: player.proxy, bodyB: target.handle,
            worldAnchorA: anchor, worldAnchorB: targetPosition,
            length, hertz: 7, dampingRatio: 0.9, maxForce: 350,
          }),
        };
      }
    }
    return player;
  }

  #persistPlayer(player: Player): PersistedWorld["players"][number] {
    const grabbed = player.grab
      ? this.#runtimeBodies.find((body) => key(body.handle) === key(player.grab!.target))
      : null;
    return {
      persistentId: player.persistentId,
      position: { ...player.state.position },
      yaw: player.state.yaw,
      verticalVelocity: player.state.verticalVelocity,
      grounded: player.state.grounded,
      lastJumpCounter: player.state.lastJumpCounter,
      stepCooldown: player.state.stepCooldown,
      crouched: player.state.crouched,
      grabbedAuthoredId: grabbed?.authoredId ?? null,
      grabLength: player.grab?.length ?? 0,
    };
  }

  #players(): Player[] {
    return this.#playerSlots.flatMap((slot) => slot.player ? [slot.player] : []);
  }

  #snapshotFlags(id: RuntimeId, position: Vec3, awake: boolean): number {
    const identity = key(id);
    const previous = this.#replicationState.get(identity);
    let flags = previous ? 0 : SNAPSHOT_FLAG_CREATED;
    if (previous) {
      if (!previous.awake && awake) flags |= SNAPSHOT_FLAG_WAKE;
      if (previous.awake && !awake) flags |= SNAPSHOT_FLAG_SLEEP;
      if (Math.hypot(
        position.x - previous.position.x,
        position.y - previous.position.y,
        position.z - previous.position.z,
      ) >= 2) flags |= SNAPSHOT_FLAG_TELEPORT;
    }
    this.#replicationState.set(identity, { position: { ...position }, awake });
    return flags;
  }

  #resolvePlayer(id: RuntimeId): { slotIndex: number; slot: PlayerSlot; player: Player } | null {
    const slotIndex = id.index - PLAYER_INDEX_BASE;
    const slot = this.#playerSlots[slotIndex];
    if (!slot || slot.generation !== id.generation || !slot.player) return null;
    return { slotIndex, slot, player: slot.player };
  }
}

function yawRotation(yaw: number) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function key(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
