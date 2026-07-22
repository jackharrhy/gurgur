import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "gurgur-persistence-"));
const filename = join(directory, "world.sqlite");
const db = new Database(filename, { create: true });

type BodyState = {
  authoredId: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  sleeping: boolean;
  mechanismState: string;
};

try {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE world_snapshot (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      map_revision TEXT NOT NULL,
      world_epoch INTEGER NOT NULL,
      server_tick INTEGER NOT NULL,
      saved_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE body_state (
      authored_id TEXT PRIMARY KEY,
      px REAL NOT NULL, py REAL NOT NULL, pz REAL NOT NULL,
      qx REAL NOT NULL, qy REAL NOT NULL, qz REAL NOT NULL, qw REAL NOT NULL,
      lvx REAL NOT NULL, lvy REAL NOT NULL, lvz REAL NOT NULL,
      avx REAL NOT NULL, avy REAL NOT NULL, avz REAL NOT NULL,
      sleeping INTEGER NOT NULL CHECK (sleeping IN (0, 1)),
      mechanism_state TEXT NOT NULL
    ) STRICT;
  `);

  const writeSnapshot = db.transaction((mapRevision: string, worldEpoch: number, tick: number, bodies: BodyState[]) => {
    db.run("DELETE FROM body_state");
    const insert = db.prepare(`
      INSERT INTO body_state VALUES (
        $authoredId,
        $px, $py, $pz,
        $qx, $qy, $qz, $qw,
        $lvx, $lvy, $lvz,
        $avx, $avy, $avz,
        $sleeping,
        $mechanismState
      )
    `);
    for (const body of bodies) {
      insert.run({
        $authoredId: body.authoredId,
        $px: body.position[0], $py: body.position[1], $pz: body.position[2],
        $qx: body.rotation[0], $qy: body.rotation[1], $qz: body.rotation[2], $qw: body.rotation[3],
        $lvx: body.linearVelocity[0], $lvy: body.linearVelocity[1], $lvz: body.linearVelocity[2],
        $avx: body.angularVelocity[0], $avy: body.angularVelocity[1], $avz: body.angularVelocity[2],
        $sleeping: body.sleeping ? 1 : 0,
        $mechanismState: body.mechanismState,
      });
    }
    db.prepare(`
      INSERT INTO world_snapshot VALUES (1, 1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        schema_version = excluded.schema_version,
        map_revision = excluded.map_revision,
        world_epoch = excluded.world_epoch,
        server_tick = excluded.server_tick,
        saved_at_ms = excluded.saved_at_ms
    `).run(mapRevision, worldEpoch, tick, Date.now());
  });

  function restore(expectedMapRevision: string) {
    const header = db.query("SELECT * FROM world_snapshot WHERE singleton = 1").get() as any;
    if (!header || header.map_revision !== expectedMapRevision) return null;
    const bodies = db.query("SELECT * FROM body_state ORDER BY authored_id").all();
    return { header, bodies };
  }

  const bodies: BodyState[] = [
    {
      authoredId: "door.main",
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      sleeping: true,
      mechanismState: "closed",
    },
    {
      authoredId: "crate.1",
      position: [-2, 0.5, 4],
      rotation: [0, 0.7071067, 0, 0.7071067],
      linearVelocity: [1, 0, 0],
      angularVelocity: [0, 0.1, 0],
      sleeping: false,
      mechanismState: "idle",
    },
  ];

  writeSnapshot("map-a", 3, 120, bodies);
  const restored = restore("map-a");
  assert.equal(restored?.header.world_epoch, 3);
  assert.equal(restored?.header.server_tick, 120);
  assert.deepEqual(restored?.bodies.map((body: any) => body.authored_id), ["crate.1", "door.main"]);
  assert.equal(restore("map-b"), null, "map revision mismatch must reject a save");

  writeSnapshot("map-a", 4, 0, []);
  const reset = restore("map-a");
  assert.equal(reset?.header.world_epoch, 4);
  assert.equal(reset?.bodies.length, 0);

  assert.equal(db.query("PRAGMA journal_mode").get()?.journal_mode, "wal");
  console.log("Bun SQLite snapshot transaction and reset restore: passed");
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
