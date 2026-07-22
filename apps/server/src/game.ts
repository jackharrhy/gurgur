import { createHash } from "node:crypto";
import {
  PLAYER_HALF_HEIGHT,
  PhysicsWorld,
  stepPlayerController,
  type BodyKind,
  type ConstraintId,
  type PhysicsStepEvents,
  type PlayerControllerState,
} from "@gurgur/physics";
import {
  MAX_CATCH_UP_TICKS,
  INPUT_INTENT_TIMEOUT_TICKS,
  PHYSICS_DT,
  PHYSICS_SUBSTEPS,
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL_TICKS,
  SNAPSHOT_FLAG_CREATED,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_TELEPORT,
  SNAPSHOT_FLAG_WAKE,
  decodeWorldBundle,
  encodeWorldBundle,
  type InputCommand,
  type RuntimeEntity,
  type RuntimeId,
  type Snapshot,
  type Vec3,
  type WorldMessage,
} from "@gurgur/shared";
import type { PersistedWorld, WorldStore } from "./store";

const SAVE_INTERVAL_TICKS = 5 / PHYSICS_DT;
const worldBundleFile = Bun.file(new URL("../../../content/generated/systems-garden.bin", import.meta.url));
if (!await worldBundleFile.exists()) throw new Error("compiled Systems Garden bundle is missing; run bun run compile:map");
const WORLD_BUNDLE = decodeWorldBundle(await worldBundleFile.arrayBuffer());
const computedRevision = createHash("sha256").update(encodeWorldBundle({
  ...WORLD_BUNDLE,
  mapRevision: "0".repeat(64),
})).digest("hex");
if (computedRevision !== WORLD_BUNDLE.mapRevision) throw new Error("compiled Systems Garden bundle revision mismatch");
const PLAYER_INDEX_BASE = 0x8000_0000;
type PhysicalRuntimeEntity = Extract<RuntimeEntity, { brushIndex: number }>;
type RuntimeBody = PhysicalRuntimeEntity & { handle: RuntimeId };
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
type Trigger = {
  handle: RuntimeId;
  authoredId: string;
  classname: "trigger_once" | "trigger_multiple";
  target: string;
  waitTicks: number;
  readyAtTick: number;
  consumed: boolean;
};
type Mechanism = {
  handle: RuntimeId;
  authoredId: string;
  classname: "func_door" | "func_platform";
  targetname: string;
  start: Vec3;
  end: Vec3;
  speed: number;
  waitTicks: number;
  progress: number;
  direction: -1 | 0 | 1;
  resumeAtTick: number;
};
type Relay = { authoredId: string; targetname: string; target: string; delayTicks: number; once: boolean; fired: boolean };
type Button = { handle: RuntimeId; authoredId: string; target: string; waitTicks: number; readyAtTick: number };

export class AuthoritativeGame {
  readonly #physics: PhysicsWorld;
  readonly #store: WorldStore;
  readonly #onSnapshot: (snapshot: Snapshot) => void;
  readonly #onWorld: (world: WorldMessage) => void;
  #runtimeBodies: RuntimeBody[] = [];
  #triggers: Trigger[] = [];
  #mechanisms: Mechanism[] = [];
  #relays: Relay[] = [];
  #buttons: Button[] = [];
  #delayedSignals: Array<{ target: string; dueTick: number }> = [];
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
    store: WorldStore,
    onSnapshot: (snapshot: Snapshot) => void,
    onWorld: (world: WorldMessage) => void,
    worldEpoch: number,
    serverTick: number,
    playerSpawn: Vec3 | null,
  ) {
    this.#physics = physics;
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
    options: { playerSpawn?: Vec3; extraDynamicBodies?: number } = {},
  ): Promise<AuthoritativeGame> {
    const physics = await PhysicsWorld.create();
    physics.createStaticMesh({
      vertices: WORLD_BUNDLE.staticCollision.vertices,
      triangles: WORLD_BUNDLE.staticCollision.triangles,
    });
    const restored = store.load(WORLD_BUNDLE.mapRevision);
    const game = new AuthoritativeGame(
      physics,
      store,
      onSnapshot,
      onWorld,
      restored?.worldEpoch ?? 1,
      restored?.serverTick ?? 0,
      options.playerSpawn ? { ...options.playerSpawn } : null,
    );
    game.#spawnRuntimeBodies(restored);
    game.#extraDynamicBodyCount = options.extraDynamicBodies ?? 0;
    game.#spawnExtraDynamicBodies(restored, game.#extraDynamicBodyCount);
    game.#spawnMechanismsAndTriggers(restored);
    for (const player of restored?.players ?? []) game.#dormantPlayers.set(player.persistentId, structuredClone(player));
    return game;
  }

  get worldEpoch(): number { return this.#worldEpoch; }
  get serverTick(): number { return this.#serverTick; }
  get mapRevision(): string { return WORLD_BUNDLE.mapRevision; }
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
      this.#stepMechanisms();
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
    const bodies = this.#runtimeBodies.flatMap(({ handle }) => {
      const identity = key(handle);
      if (!full && !this.#dirtyBodies.has(identity)) return [];
      const { awake, ...state } = this.#physics.state(handle);
      return [{ ...state, flags: this.#snapshotFlags(handle, state.position, awake) }];
    });
    if (!full) this.#dirtyBodies.clear();
    return {
      worldEpoch: this.#worldEpoch,
      serverTick: this.#serverTick,
      bodies: bodies.concat(this.#players().map((player) => ({
        id: player.id,
        position: player.state.position,
        rotation: yawRotation(player.state.yaw),
        linearVelocity: { x: 0, y: player.state.verticalVelocity, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        flags: this.#snapshotFlags(player.id, player.state.position, true),
      }))),
      players: this.#players().map((player) => ({
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
      bundle: WORLD_BUNDLE,
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
      vertices: WORLD_BUNDLE.staticCollision.vertices,
      triangles: WORLD_BUNDLE.staticCollision.triangles,
    });
    this.#runtimeBodies = [];
    this.#triggers = [];
    this.#mechanisms = [];
    this.#relays = [];
    this.#buttons = [];
    this.#delayedSignals = [];
    this.#dormantPlayers.clear();
    this.#saveRequested = false;
    this.#replicationState.clear();
    this.#dirtyBodies.clear();
    this.#worldEpoch += 1;
    this.#serverTick = 0;
    this.#accumulator = 0;
    this.#spawnRuntimeBodies(null);
    this.#spawnExtraDynamicBodies(null, this.#extraDynamicBodyCount);
    this.#spawnMechanismsAndTriggers(null);
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
    this.#store.save(WORLD_BUNDLE.mapRevision, {
      worldEpoch: this.#worldEpoch,
      serverTick: this.#serverTick,
      bodies: this.#runtimeBodies.map((body) => ({
        authoredId: body.authoredId,
        ...this.#physics.state(body.handle),
      })),
      mechanisms: this.#mechanisms.map((mechanism) => ({
        authoredId: mechanism.authoredId,
        progress: mechanism.progress,
        direction: mechanism.direction,
        resumeAtTick: mechanism.resumeAtTick,
      })),
      signals: [
        ...this.#triggers.map((trigger) => ({
          authoredId: trigger.authoredId,
          kind: "trigger" as const,
          readyAtTick: trigger.readyAtTick,
          latched: trigger.consumed,
        })),
        ...this.#relays.map((relay) => ({
          authoredId: relay.authoredId,
          kind: "relay" as const,
          readyAtTick: 0,
          latched: relay.fired,
        })),
        ...this.#buttons.map((button) => ({
          authoredId: button.authoredId,
          kind: "button" as const,
          readyAtTick: button.readyAtTick,
          latched: false,
        })),
      ],
      delayedSignals: this.#delayedSignals.map((signal) => ({ ...signal })),
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

  #spawnRuntimeBodies(restored: PersistedWorld | null): void {
    const restoredById = new Map(restored?.bodies.map((body) => [body.authoredId, body]));
    for (const [entityIndex, entity] of WORLD_BUNDLE.entities.entries()) {
      if (
        entity.classname !== "func_physics"
        && entity.classname !== "func_door"
        && entity.classname !== "func_platform"
        && entity.classname !== "func_button"
      ) continue;
      if (!entity.authoredId || entity.brushIndices.length === 0) {
        throw new Error(`physical map entity ${entityIndex} must have at least one brush and an authoredId`);
      }
      const brushIndex = entity.brushIndices[0]!;
      const brush = WORLD_BUNDLE.brushes[brushIndex]!;
      const type: BodyKind = entity.classname === "func_physics"
        ? "dynamic"
        : entity.classname === "func_button" ? "static" : "kinematic";
      const material = {
        density: Number(entity.runtimeProperties.density ?? 1),
        friction: Number(entity.runtimeProperties.friction ?? 0.6),
        restitution: Number(entity.runtimeProperties.restitution ?? 0),
      };
      const saved = restoredById.get(entity.authoredId);
      const hulls = entity.brushIndices.map((index) => ({
        vertices: WORLD_BUNDLE.brushes[index]!.worldVertices.map((vertex) => ({
          x: vertex.x - brush.center.x, y: vertex.y - brush.center.y, z: vertex.z - brush.center.z,
        })),
      }));
      const handle = entity.brushIndices.length === 1
        ? saved
          ? this.#physics.restoreHull({ type, vertices: brush.localVertices, ...material, ...saved })
          : this.#physics.createHull({ type, position: brush.center, vertices: brush.localVertices, ...material })
        : this.#physics.createCompoundHulls({
          type, position: saved?.position ?? brush.center, rotation: saved?.rotation, hulls, ...material,
        });
      if (saved && entity.brushIndices.length > 1) {
        this.#physics.setBodyVelocity(handle, saved.linearVelocity, saved.angularVelocity);
        this.#physics.setBodyAwake(handle, saved.awake);
      }
      this.#runtimeBodies.push({
        handle,
        id: handle,
        authoredId: entity.authoredId,
        classname: entity.classname,
        brushIndex,
        ...(entity.brushIndices.length > 1 ? { brushIndices: [...entity.brushIndices] } : {}),
      });
      this.#dirtyBodies.add(key(handle));
    }
  }

  #spawnExtraDynamicBodies(restored: PersistedWorld | null, count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > 512) throw new Error("extra dynamic body count must be between 0 and 512");
    if (count === 0) return;
    const templateEntity = WORLD_BUNDLE.entities.find((entity) => entity.authoredId === "physics.stack.01");
    const brushIndex = templateEntity?.brushIndices[0];
    const brush = brushIndex === undefined ? null : WORLD_BUNDLE.brushes[brushIndex];
    if (!templateEntity || brushIndex === undefined || !brush) throw new Error("dynamic stress-body template is missing");
    const restoredById = new Map(restored?.bodies.map((body) => [body.authoredId, body]));
    for (let index = 0; index < count; index += 1) {
      const authoredId = `stress.dynamic.${index.toString().padStart(3, "0")}`;
      const saved = restoredById.get(authoredId);
      const position = {
        x: 2 + (index % 8) * 3,
        y: 1 + Math.floor(index / 32) * 1.3,
        z: -18 + (Math.floor(index / 8) % 4) * 3,
      };
      const handle = saved
        ? this.#physics.restoreHull({ type: "dynamic", vertices: brush.localVertices, density: 1, ...saved })
        : this.#physics.createHull({ type: "dynamic", position, vertices: brush.localVertices, density: 1 });
      this.#runtimeBodies.push({
        id: handle, handle, authoredId, classname: "func_physics", brushIndex,
      });
      this.#dirtyBodies.add(key(handle));
    }
  }

  #spawnMechanismsAndTriggers(restored: PersistedWorld | null): void {
    const bodyByAuthoredId = new Map(this.#runtimeBodies.map((body) => [body.authoredId, body]));
    const restoredMechanisms = new Map(restored?.mechanisms.map((state) => [state.authoredId, state]));
    const restoredSignals = new Map(restored?.signals.map((state) => [state.authoredId, state]));
    this.#delayedSignals = restored?.delayedSignals.map((signal) => ({ ...signal })) ?? [];
    this.#delayedSignals.sort((a, b) => a.dueTick - b.dueTick);
    for (const entity of WORLD_BUNDLE.entities) {
      if (entity.classname === "trigger_once" || entity.classname === "trigger_multiple") {
        if (!entity.authoredId) throw new Error(`${entity.classname} requires an authoredId`);
        const brush = WORLD_BUNDLE.brushes[entity.brushIndices[0]!]!;
        const saved = restoredSignals.get(entity.authoredId);
        this.#triggers.push({
          handle: this.#physics.createSensorHull({ position: { x: 0, y: 0, z: 0 }, vertices: brush.worldVertices }),
          authoredId: entity.authoredId,
          classname: entity.classname,
          target: String(entity.runtimeProperties.target),
          waitTicks: Math.max(1, Math.ceil(Number(entity.runtimeProperties.wait ?? 0) / PHYSICS_DT)),
          readyAtTick: saved?.kind === "trigger" ? saved.readyAtTick : 0,
          consumed: saved?.kind === "trigger" ? saved.latched : false,
        });
      } else if (entity.classname === "logic_relay") {
        if (!entity.authoredId) throw new Error("logic_relay requires an authoredId");
        const saved = restoredSignals.get(entity.authoredId);
        this.#relays.push({
          authoredId: entity.authoredId,
          targetname: String(entity.runtimeProperties.targetname),
          target: String(entity.runtimeProperties.target),
          delayTicks: Math.max(0, Math.ceil(Number(entity.runtimeProperties.delay) / PHYSICS_DT)),
          once: Boolean(entity.runtimeProperties.once),
          fired: saved?.kind === "relay" ? saved.latched : false,
        });
      } else if (entity.classname === "func_button") {
        const body = bodyByAuthoredId.get(entity.authoredId!);
        if (!body) throw new Error(`button body ${entity.authoredId} is missing`);
        this.#buttons.push({
          handle: body.handle,
          authoredId: entity.authoredId!,
          target: String(entity.runtimeProperties.target),
          waitTicks: Math.max(1, Math.ceil(Number(entity.runtimeProperties.wait) / PHYSICS_DT)),
          readyAtTick: restoredSignals.get(entity.authoredId!)?.kind === "button"
            ? restoredSignals.get(entity.authoredId!)!.readyAtTick
            : 0,
        });
      } else if (entity.classname === "func_door" || entity.classname === "func_platform") {
        const body = bodyByAuthoredId.get(entity.authoredId!);
        if (!body) throw new Error(`mechanism body ${entity.authoredId} is missing`);
        const start = { ...WORLD_BUNDLE.brushes[entity.brushIndices[0]!]!.center };
        const direction = entity.runtimeProperties.moveDirection as Vec3;
        const distance = Number(entity.runtimeProperties.distance);
        const end = {
          x: start.x + direction.x * distance,
          y: start.y + direction.y * distance,
          z: start.z + direction.z * distance,
        };
        const startOpen = Boolean(entity.runtimeProperties.startOpen);
        const saved = restoredMechanisms.get(entity.authoredId!);
        const mechanism: Mechanism = {
          handle: body.handle,
          authoredId: entity.authoredId!,
          classname: entity.classname,
          targetname: String(entity.runtimeProperties.targetname),
          start,
          end,
          speed: Number(entity.runtimeProperties.speed),
          waitTicks: Math.max(0, Math.ceil(Number(entity.runtimeProperties.wait) / PHYSICS_DT)),
          progress: saved?.progress ?? (startOpen ? 1 : 0),
          direction: saved?.direction ?? 0,
          resumeAtTick: saved?.resumeAtTick ?? 0,
        };
        this.#mechanisms.push(mechanism);
        this.#setMechanismTransform(mechanism, true);
      }
    }
  }

  #stepMechanisms(): void {
    while (this.#delayedSignals[0] && this.#delayedSignals[0].dueTick <= this.#serverTick) {
      const signal = this.#delayedSignals.shift()!;
      this.#saveRequested = true;
      this.#emitTarget(signal.target);
    }
    for (const mechanism of this.#mechanisms) {
      if (mechanism.direction === 0 && mechanism.resumeAtTick > 0 && mechanism.resumeAtTick <= this.#serverTick) {
        mechanism.direction = mechanism.progress >= 1 ? -1 : 1;
        mechanism.resumeAtTick = 0;
      }
      if (mechanism.direction === 0) {
        this.#physics.setBodyVelocity(mechanism.handle, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        continue;
      }
      const distance = Math.hypot(
        mechanism.end.x - mechanism.start.x,
        mechanism.end.y - mechanism.start.y,
        mechanism.end.z - mechanism.start.z,
      );
      if (distance <= Number.EPSILON || mechanism.speed <= 0) {
        mechanism.direction = 0;
        continue;
      }
      mechanism.progress = clamp(mechanism.progress + mechanism.direction * mechanism.speed * PHYSICS_DT / distance, 0, 1);
      this.#setMechanismTransform(mechanism);
      if (mechanism.progress === 0 || mechanism.progress === 1) {
        const reachedOpen = mechanism.progress === 1;
        mechanism.direction = 0;
        if (mechanism.classname === "func_platform" || reachedOpen) {
          mechanism.resumeAtTick = this.#serverTick + mechanism.waitTicks;
        }
        this.#saveRequested = true;
      }
    }
  }

  #setMechanismTransform(mechanism: Mechanism, teleport = false): void {
    const position = {
      x: mechanism.start.x + (mechanism.end.x - mechanism.start.x) * mechanism.progress,
      y: mechanism.start.y + (mechanism.end.y - mechanism.start.y) * mechanism.progress,
      z: mechanism.start.z + (mechanism.end.z - mechanism.start.z) * mechanism.progress,
    };
    if (teleport) {
      this.#physics.setBodyTransform(mechanism.handle, position, { x: 0, y: 0, z: 0, w: 1 });
      this.#physics.setBodyVelocity(mechanism.handle, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      return;
    }
    const current = this.#physics.state(mechanism.handle).position;
    this.#physics.setBodyVelocity(mechanism.handle, {
      x: (position.x - current.x) / PHYSICS_DT,
      y: (position.y - current.y) / PHYSICS_DT,
      z: (position.z - current.z) / PHYSICS_DT,
    }, { x: 0, y: 0, z: 0 });
  }

  #processPostPhysics(events: PhysicsStepEvents): void {
    for (const event of events.moved) this.#dirtyBodies.add(key(event.body));
    const playerProxyKeys = new Set(this.#players().map((player) => key(player.proxy)));
    for (const event of events.sensorBegin) {
      if (!playerProxyKeys.has(key(event.visitor))) continue;
      const trigger = this.#triggers.find((candidate) => key(candidate.handle) === key(event.sensor));
      if (!trigger || trigger.consumed || trigger.readyAtTick > this.#serverTick) continue;
      this.#emitTarget(trigger.target);
      if (trigger.classname === "trigger_once") trigger.consumed = true;
      else trigger.readyAtTick = this.#serverTick + trigger.waitTicks;
      this.#saveRequested = true;
    }
  }

  #emitTarget(targetname: string): void {
    for (const relay of this.#relays.filter((candidate) => candidate.targetname === targetname)) {
      if (relay.once && relay.fired) continue;
      relay.fired = true;
      this.#delayedSignals.push({ target: relay.target, dueTick: this.#serverTick + relay.delayTicks });
      this.#delayedSignals.sort((a, b) => a.dueTick - b.dueTick);
      this.#saveRequested = true;
    }
    for (const mechanism of this.#mechanisms.filter((candidate) => candidate.targetname === targetname)) {
      mechanism.direction = mechanism.progress >= 1 ? -1 : 1;
      mechanism.resumeAtTick = 0;
      this.#saveRequested = true;
    }
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
    const button = this.#buttons.find((candidate) => key(candidate.handle) === key(target));
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
    this.#emitTarget(button.target);
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
    const spawn = WORLD_BUNDLE.entities.find((entity) => entity.classname === "info_player_start")?.origin;
    if (!spawn) throw new Error("map requires an info_player_start");
    const yaw = Number(WORLD_BUNDLE.entities.find((entity) => entity.classname === "info_player_start")?.runtimeProperties.angle ?? 0);
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
