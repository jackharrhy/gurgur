import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Quat, Vec3 } from "@gurgur/shared";

export type PersistedWorld = {
  worldEpoch: number;
  serverTick: number;
  bodies: Array<{
    authoredId: string;
    position: Vec3;
    rotation: Quat;
    linearVelocity: Vec3;
    angularVelocity: Vec3;
    awake: boolean;
  }>;
  mechanisms: Array<{
    authoredId: string;
    progress: number;
    direction: -1 | 0 | 1;
    resumeAtTick: number;
  }>;
  signals: Array<{
    authoredId: string;
    kind: "trigger" | "relay" | "button";
    readyAtTick: number;
    latched: boolean;
  }>;
  delayedSignals: Array<{
    target: string;
    dueTick: number;
  }>;
  players: Array<{
    persistentId: string;
    position: Vec3;
    yaw: number;
    verticalVelocity: number;
    grounded: boolean;
    lastJumpCounter: number;
    stepCooldown: number;
    crouched: boolean;
    grabbedAuthoredId: string | null;
    grabLength: number;
  }>;
};

type WorldRow = {
  map_revision: string;
  world_epoch: number;
  server_tick: number;
};

type BodyRow = {
  authored_id: string;
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  awake: number;
};

type MechanismRow = {
  authored_id: string;
  progress: number;
  direction: number;
  resume_at_tick: number;
};

type PlayerRow = {
  persistent_id: string;
  px: number;
  py: number;
  pz: number;
  yaw: number;
  vertical_velocity: number;
  grounded: number;
  last_jump_counter: number;
  step_cooldown: number;
  crouched: number;
  grabbed_authored_id: string | null;
  grab_length: number;
};

type SignalRow = {
  authored_id: string;
  kind: "trigger" | "relay" | "button";
  ready_at_tick: number;
  latched: number;
};

type DelayedSignalRow = {
  ordinal: number;
  target: string;
  due_tick: number;
};

export class WorldStore {
  readonly #database: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") this.#database.run("PRAGMA journal_mode = WAL");
    this.#database.run("PRAGMA foreign_keys = ON");
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS world_snapshot (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        map_revision TEXT NOT NULL,
        world_epoch INTEGER NOT NULL,
        server_tick INTEGER NOT NULL,
        saved_at_ms INTEGER NOT NULL
      ) STRICT
    `);
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS body_state (
        authored_id TEXT PRIMARY KEY,
        px REAL NOT NULL, py REAL NOT NULL, pz REAL NOT NULL,
        qx REAL NOT NULL, qy REAL NOT NULL, qz REAL NOT NULL, qw REAL NOT NULL,
        vx REAL NOT NULL, vy REAL NOT NULL, vz REAL NOT NULL,
        wx REAL NOT NULL, wy REAL NOT NULL, wz REAL NOT NULL,
        awake INTEGER NOT NULL DEFAULT 1 CHECK (awake IN (0, 1))
      ) STRICT
    `);
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS mechanism_state (
        authored_id TEXT PRIMARY KEY,
        progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
        direction INTEGER NOT NULL CHECK (direction IN (-1, 0, 1)),
        resume_at_tick INTEGER NOT NULL CHECK (resume_at_tick >= 0)
      ) STRICT
    `);
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS player_state (
        persistent_id TEXT PRIMARY KEY,
        px REAL NOT NULL, py REAL NOT NULL, pz REAL NOT NULL,
        yaw REAL NOT NULL,
        vertical_velocity REAL NOT NULL,
        grounded INTEGER NOT NULL CHECK (grounded IN (0, 1)),
        last_jump_counter INTEGER NOT NULL CHECK (last_jump_counter >= 0),
        step_cooldown INTEGER NOT NULL CHECK (step_cooldown >= 0),
        crouched INTEGER NOT NULL CHECK (crouched IN (0, 1)),
        grabbed_authored_id TEXT,
        grab_length REAL NOT NULL DEFAULT 0 CHECK (grab_length >= 0)
      ) STRICT
    `);
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS signal_state (
        authored_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('trigger', 'relay', 'button')),
        ready_at_tick INTEGER NOT NULL CHECK (ready_at_tick >= 0),
        latched INTEGER NOT NULL CHECK (latched IN (0, 1))
      ) STRICT
    `);
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS delayed_signal (
        ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 0),
        target TEXT NOT NULL,
        due_tick INTEGER NOT NULL CHECK (due_tick >= 0)
      ) STRICT
    `);
  }

  load(mapRevision: string): PersistedWorld | null {
    const world = this.#database
      .query<WorldRow, []>(`
      SELECT map_revision, world_epoch, server_tick
      FROM world_snapshot WHERE singleton = 1
    `)
      .get();
    if (!world || world.map_revision !== mapRevision) return null;
    const bodies = this.#database
      .query<BodyRow, []>(`
      SELECT authored_id, px, py, pz, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz, awake
      FROM body_state ORDER BY authored_id
    `)
      .all();
    const mechanisms = this.#database
      .query<MechanismRow, []>(`
      SELECT authored_id, progress, direction, resume_at_tick
      FROM mechanism_state ORDER BY authored_id
    `)
      .all();
    const players = this.#database
      .query<PlayerRow, []>(`
      SELECT persistent_id, px, py, pz, yaw, vertical_velocity, grounded,
             last_jump_counter, step_cooldown, crouched, grabbed_authored_id, grab_length
      FROM player_state ORDER BY persistent_id
    `)
      .all();
    const signals = this.#database
      .query<SignalRow, []>(`
      SELECT authored_id, kind, ready_at_tick, latched
      FROM signal_state ORDER BY authored_id
    `)
      .all();
    const delayedSignals = this.#database
      .query<DelayedSignalRow, []>(`
      SELECT ordinal, target, due_tick
      FROM delayed_signal ORDER BY ordinal
    `)
      .all();
    return {
      worldEpoch: world.world_epoch,
      serverTick: world.server_tick,
      bodies: bodies.map((body) => ({
        authoredId: body.authored_id,
        position: { x: body.px, y: body.py, z: body.pz },
        rotation: { x: body.qx, y: body.qy, z: body.qz, w: body.qw },
        linearVelocity: { x: body.vx, y: body.vy, z: body.vz },
        angularVelocity: { x: body.wx, y: body.wy, z: body.wz },
        awake: body.awake === 1,
      })),
      mechanisms: mechanisms.map((mechanism) => ({
        authoredId: mechanism.authored_id,
        progress: mechanism.progress,
        direction: mechanism.direction as -1 | 0 | 1,
        resumeAtTick: mechanism.resume_at_tick,
      })),
      signals: signals.map((signal) => ({
        authoredId: signal.authored_id,
        kind: signal.kind,
        readyAtTick: signal.ready_at_tick,
        latched: signal.latched === 1,
      })),
      delayedSignals: delayedSignals.map((signal) => ({
        target: signal.target,
        dueTick: signal.due_tick,
      })),
      players: players.map((player) => ({
        persistentId: player.persistent_id,
        position: { x: player.px, y: player.py, z: player.pz },
        yaw: player.yaw,
        verticalVelocity: player.vertical_velocity,
        grounded: player.grounded === 1,
        lastJumpCounter: player.last_jump_counter,
        stepCooldown: player.step_cooldown,
        crouched: player.crouched === 1,
        grabbedAuthoredId: player.grabbed_authored_id,
        grabLength: player.grab_length,
      })),
    };
  }

  save(mapRevision: string, world: PersistedWorld): void {
    const transaction = this.#database.transaction(() => {
      this.#database
        .query(`
        INSERT INTO world_snapshot (
          singleton, map_revision, world_epoch, server_tick, saved_at_ms
        ) VALUES (1, $mapRevision, $worldEpoch, $serverTick, $savedAtMs)
        ON CONFLICT(singleton) DO UPDATE SET
          map_revision = excluded.map_revision,
          world_epoch = excluded.world_epoch,
          server_tick = excluded.server_tick,
          saved_at_ms = excluded.saved_at_ms
      `)
        .run({
          mapRevision,
          worldEpoch: world.worldEpoch,
          serverTick: world.serverTick,
          savedAtMs: Date.now(),
        });
      this.#database.run("DELETE FROM body_state");
      const insertBody = this.#database.query(`
        INSERT INTO body_state (
          authored_id, px, py, pz, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz, awake
        ) VALUES (
          $authoredId, $px, $py, $pz, $qx, $qy, $qz, $qw, $vx, $vy, $vz, $wx, $wy, $wz, $awake
        )
      `);
      for (const body of world.bodies) {
        insertBody.run({
          authoredId: body.authoredId,
          px: body.position.x,
          py: body.position.y,
          pz: body.position.z,
          qx: body.rotation.x,
          qy: body.rotation.y,
          qz: body.rotation.z,
          qw: body.rotation.w,
          vx: body.linearVelocity.x,
          vy: body.linearVelocity.y,
          vz: body.linearVelocity.z,
          wx: body.angularVelocity.x,
          wy: body.angularVelocity.y,
          wz: body.angularVelocity.z,
          awake: Number(body.awake),
        });
      }
      this.#database.run("DELETE FROM mechanism_state");
      const insertMechanism = this.#database.query(`
        INSERT INTO mechanism_state (authored_id, progress, direction, resume_at_tick)
        VALUES ($authoredId, $progress, $direction, $resumeAtTick)
      `);
      for (const mechanism of world.mechanisms) insertMechanism.run(mechanism);
      this.#database.run("DELETE FROM signal_state");
      const insertSignal = this.#database.query(`
        INSERT INTO signal_state (authored_id, kind, ready_at_tick, latched)
        VALUES ($authoredId, $kind, $readyAtTick, $latched)
      `);
      for (const signal of world.signals)
        insertSignal.run({ ...signal, latched: Number(signal.latched) });
      this.#database.run("DELETE FROM delayed_signal");
      const insertDelayedSignal = this.#database.query(`
        INSERT INTO delayed_signal (ordinal, target, due_tick)
        VALUES ($ordinal, $target, $dueTick)
      `);
      for (const [ordinal, signal] of world.delayedSignals.entries()) {
        insertDelayedSignal.run({ ordinal, target: signal.target, dueTick: signal.dueTick });
      }
      this.#database.run("DELETE FROM player_state");
      const insertPlayer = this.#database.query(`
        INSERT INTO player_state (
          persistent_id, px, py, pz, yaw, vertical_velocity, grounded,
          last_jump_counter, step_cooldown, crouched, grabbed_authored_id, grab_length
        ) VALUES (
          $persistentId, $px, $py, $pz, $yaw, $verticalVelocity, $grounded,
          $lastJumpCounter, $stepCooldown, $crouched, $grabbedAuthoredId, $grabLength
        )
      `);
      for (const player of world.players)
        insertPlayer.run({
          persistentId: player.persistentId,
          px: player.position.x,
          py: player.position.y,
          pz: player.position.z,
          yaw: player.yaw,
          verticalVelocity: player.verticalVelocity,
          grounded: Number(player.grounded),
          lastJumpCounter: player.lastJumpCounter,
          stepCooldown: player.stepCooldown,
          crouched: Number(player.crouched),
          grabbedAuthoredId: player.grabbedAuthoredId,
          grabLength: player.grabLength,
        });
    });
    transaction();
  }

  close(): void {
    this.#database.close();
  }
}
