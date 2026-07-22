import { describe, expect, test } from "bun:test";
import {
  INPUT_INTENT_TIMEOUT_TICKS,
  PHYSICS_DT,
  PROTOCOL_VERSION,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_TELEPORT,
  type Snapshot,
  type WorldMessage,
} from "@gurgur/shared";
import { AuthoritativeGame } from "../src/game";
import { WorldStore } from "../src/store";

const key = (id: { index: number; generation: number }) => `${id.index}:${id.generation}`;

describe("map-authored authoritative world", () => {
  test("settles dynamic map hulls on compiled static collision and rebuilds them on reset", async () => {
    const store = new WorldStore(":memory:");
    const worldMessages: WorldMessage[] = [];
    const game = await AuthoritativeGame.create(store, () => {}, (world) => worldMessages.push(world));
    try {
      const manifest = game.worldMessage();
      expect(manifest.bundle.brushes.length).toBe(32);
      expect(manifest.runtimeEntities.length).toBe(10);
      expect(manifest.runtimeEntities.filter((entity) => entity.classname === "func_physics").length).toBe(6);
      for (let tick = 0; tick < 240; tick += 1) game.advance(PHYSICS_DT);
      const settled = game.snapshot();
      expect(settled.bodies.length).toBe(10);
      for (const body of settled.bodies) {
        expect(Object.values(body.position).every(Number.isFinite)).toBe(true);
        expect(body.position.y).toBeGreaterThan(-0.05);
      }

      const oldIds = new Set(manifest.runtimeEntities.map((entity) => key(entity.id)));
      game.reset();
      const resetWorld = worldMessages.at(-1)!;
      expect(resetWorld.worldEpoch).toBe(2);
      expect(resetWorld.runtimeEntities.every((entity) => !oldIds.has(key(entity.id)))).toBe(true);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("drives a compiled trigger through its relay delay into a moving door", async () => {
    const store = new WorldStore(":memory:");
    const bootstrap = await AuthoritativeGame.create(store, () => {}, () => {});
    const bundle = bootstrap.worldMessage().bundle;
    bootstrap.stop();
    const triggerEntity = bundle.entities.find((entity) => entity.authoredId === "trigger.once.welcome")!;
    const triggerCenter = bundle.brushes[triggerEntity.brushIndices[0]!]!.center;
    const game = await AuthoritativeGame.create(store, () => {}, () => {}, { playerSpawn: triggerCenter });
    try {
      game.connectPlayer();
      const door = game.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "mechanism.door.main")!;
      const initialY = game.snapshot().bodies.find((body) => key(body.id) === key(door.id))!.position.y;

      for (let tick = 0; tick < Math.ceil(0.75 / PHYSICS_DT); tick += 1) game.advance(PHYSICS_DT);

      const movedY = game.snapshot().bodies.find((body) => key(body.id) === key(door.id))!.position.y;
      expect(movedY).toBeGreaterThan(initialY + 0.5);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("persists trigger latches and queued relay work across a process restart", async () => {
    const store = new WorldStore(":memory:");
    const bootstrap = await AuthoritativeGame.create(store, () => {}, () => {});
    const bundle = bootstrap.worldMessage().bundle;
    bootstrap.stop();
    const triggerEntity = bundle.entities.find((entity) => entity.authoredId === "trigger.once.welcome")!;
    const first = await AuthoritativeGame.create(store, () => {}, () => {}, {
      playerSpawn: bundle.brushes[triggerEntity.brushIndices[0]!]!.center,
    });
    first.connectPlayer("trigger-persistence-player");
    first.advance(PHYSICS_DT);
    first.stop();

    const saved = store.load(first.mapRevision)!;
    expect(saved.signals.find((signal) => signal.authoredId === "trigger.once.welcome")).toEqual({
      authoredId: "trigger.once.welcome", kind: "trigger", readyAtTick: 0, latched: true,
    });
    expect(saved.signals.find((signal) => signal.authoredId === "logic.relay.door")?.latched).toBe(true);
    expect(saved.delayedSignals).toEqual([{ target: "door.main", dueTick: 15 }]);

    const restored = await AuthoritativeGame.create(store, () => {}, () => {});
    try {
      restored.advance(PHYSICS_DT);
      restored.save();
      expect(store.load(restored.mapRevision)?.delayedSignals).toEqual([{ target: "door.main", dueTick: 15 }]);
      expect(store.load(restored.mapRevision)?.signals.find(
        (signal) => signal.authoredId === "trigger.once.welcome",
      )?.latched).toBe(true);
      for (let tick = 0; tick < 15; tick += 1) restored.advance(PHYSICS_DT);
      expect(store.load(restored.mapRevision)?.delayedSignals).toEqual([]);
    } finally {
      restored.stop();
      store.close();
    }
  });

  test("accepts a generation-safe, in-range, unobstructed button interaction", async () => {
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(store, () => {}, () => {}, {
      playerSpawn: { x: -3.8, y: 1.02, z: -0.61 },
    });
    try {
      const playerId = game.connectPlayer();
      const button = game.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "mechanism.button.door")!;
      const door = game.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "mechanism.door.main")!;
      const initialY = game.snapshot().bodies.find((body) => key(body.id) === key(door.id))!.position.y;
      const use = (sequence: number, generation: number) => ({
        type: "input", protocolVersion: PROTOCOL_VERSION, worldEpoch: game.worldEpoch,
        sequence, clientTick: sequence, moveX: 0, moveZ: 0, lookYaw: Math.PI / 2, lookPitch: 0,
        buttons: 0, jumpCounter: 0, interactCounter: sequence,
        interactTarget: { index: button.id.index, generation }, primaryCounter: 0,
      } as const);

      expect(game.acceptInput(playerId, use(1, button.id.generation + 1))).toBe(true);
      for (let tick = 0; tick < Math.ceil(0.5 / PHYSICS_DT); tick += 1) game.advance(PHYSICS_DT);
      expect(game.snapshot().bodies.find((body) => key(body.id) === key(door.id))!.position.y).toBeCloseTo(initialY);

      expect(game.acceptInput(playerId, use(2, button.id.generation))).toBe(true);
      for (let tick = 0; tick < Math.ceil(0.75 / PHYSICS_DT); tick += 1) game.advance(PHYSICS_DT);
      expect(game.snapshot().bodies.find((body) => key(body.id) === key(door.id))!.position.y).toBeGreaterThan(initialY + 0.5);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("creates and releases a server-authoritative grab constraint on a visible dynamic body", async () => {
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(store, () => {}, () => {}, {
      playerSpawn: { x: -15.5, y: 0.9, z: 4.8768 },
    });
    try {
      for (let tick = 0; tick < 120; tick += 1) game.advance(PHYSICS_DT);
      const playerId = game.connectPlayer();
      const cube = game.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "physics.cube.heavy")!;
      const initialX = game.snapshot().bodies.find((body) => key(body.id) === key(cube.id))!.position.x;
      const command = (sequence: number, primaryCounter: number, moveZ = 0) => ({
        type: "input", protocolVersion: PROTOCOL_VERSION, worldEpoch: game.worldEpoch,
        sequence, clientTick: sequence, moveX: 0, moveZ, lookYaw: Math.PI / 2, lookPitch: 0,
        buttons: 0, jumpCounter: 0, interactCounter: 0, interactTarget: cube.id, primaryCounter,
      } as const);
      game.acceptInput(playerId, command(1, 1));
      game.advance(PHYSICS_DT);
      for (let tick = 0; tick < 60; tick += 1) {
        game.acceptInput(playerId, command(tick + 2, 1, -1));
        game.advance(PHYSICS_DT);
      }
      const pulledX = game.snapshot().bodies.find((body) => key(body.id) === key(cube.id))!.position.x;
      expect(pulledX).toBeGreaterThan(initialX + 0.25);
      expect(game.acceptInput(playerId, command(62, 2))).toBe(true);
      game.advance(PHYSICS_DT);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("restores an owned grab constraint by authored body identity", async () => {
    const store = new WorldStore(":memory:");
    const persistentId = "grab-owner";
    const first = await AuthoritativeGame.create(store, () => {}, () => {}, {
      playerSpawn: { x: -15.5, y: 0.9, z: 4.8768 },
    });
    for (let tick = 0; tick < 120; tick += 1) first.advance(PHYSICS_DT);
    const playerId = first.connectPlayer(persistentId);
    const cube = first.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "physics.cube.heavy")!;
    first.acceptInput(playerId, {
      type: "input", protocolVersion: PROTOCOL_VERSION, worldEpoch: first.worldEpoch,
      sequence: 0, clientTick: 0, moveX: 0, moveZ: 0, lookYaw: Math.PI / 2, lookPitch: 0,
      buttons: 0, jumpCounter: 0, interactCounter: 0, interactTarget: cube.id, primaryCounter: 1,
    });
    first.advance(PHYSICS_DT);
    first.stop();
    expect(store.load(first.mapRevision)?.players[0]?.grabbedAuthoredId).toBe("physics.cube.heavy");

    const restored = await AuthoritativeGame.create(store, () => {}, () => {});
    try {
      const restoredPlayer = restored.connectPlayer(persistentId);
      const restoredCube = restored.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "physics.cube.heavy")!;
      const before = restored.snapshot().bodies.find((body) => key(body.id) === key(restoredCube.id))!.position.x;
      for (let sequence = 0; sequence < 60; sequence += 1) {
        restored.acceptInput(restoredPlayer, {
          type: "input", protocolVersion: PROTOCOL_VERSION, worldEpoch: restored.worldEpoch,
          sequence, clientTick: sequence, moveX: 0, moveZ: -1, lookYaw: Math.PI / 2, lookPitch: 0,
          buttons: 0, jumpCounter: 0, interactCounter: 0, interactTarget: restoredCube.id, primaryCounter: 0,
        });
        restored.advance(PHYSICS_DT);
      }
      expect(restored.snapshot().bodies.find((body) => key(body.id) === key(restoredCube.id))!.position.x).toBeGreaterThan(before + 0.2);
    } finally {
      restored.stop();
      store.close();
    }
  });

  test("restores map bodies by authored identity", async () => {
    const store = new WorldStore(":memory:");
    const first = await AuthoritativeGame.create(store, () => {}, () => {});
    for (let tick = 0; tick < 120; tick += 1) first.advance(PHYSICS_DT);
    const saved = first.snapshot();
    first.stop();

    const restored = await AuthoritativeGame.create(store, () => {}, () => {});
    try {
      const loaded = restored.snapshot();
      expect(loaded.serverTick).toBe(saved.serverTick);
      expect(loaded.bodies.map((body) => body.position)).toEqual(saved.bodies.map((body) => body.position));
    } finally {
      restored.stop();
      store.close();
    }
  });

  test("restores an in-flight mechanism instead of returning to its authored start", async () => {
    const store = new WorldStore(":memory:");
    const bootstrap = await AuthoritativeGame.create(store, () => {}, () => {});
    const bundle = bootstrap.worldMessage().bundle;
    bootstrap.stop();
    const trigger = bundle.entities.find((entity) => entity.authoredId === "trigger.once.welcome")!;
    const first = await AuthoritativeGame.create(store, () => {}, () => {}, {
      playerSpawn: bundle.brushes[trigger.brushIndices[0]!]!.center,
    });
    first.connectPlayer();
    const doorId = first.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "mechanism.door.main")!.id;
    for (let tick = 0; tick < Math.ceil(0.6 / PHYSICS_DT); tick += 1) first.advance(PHYSICS_DT);
    const savedY = first.snapshot().bodies.find((body) => key(body.id) === key(doorId))!.position.y;
    first.stop();

    const restored = await AuthoritativeGame.create(store, () => {}, () => {});
    try {
      const restoredDoor = restored.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "mechanism.door.main")!.id;
      const restoredY = restored.snapshot().bodies.find((body) => key(body.id) === key(restoredDoor))!.position.y;
      expect(restoredY).toBeCloseTo(savedY, 4);
      restored.advance(PHYSICS_DT);
      expect(restored.snapshot().bodies.find((body) => key(body.id) === key(restoredDoor))!.position.y).toBeGreaterThan(restoredY);
    } finally {
      restored.stop();
      store.close();
    }
  });

  test("owns generation-safe players and advances accepted input", async () => {
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(store, () => {}, () => {});
    try {
      const playerId = game.connectPlayer();
      const start = game.snapshot().bodies.find((body) => key(body.id) === key(playerId))!;
      expect(game.worldMessage().runtimeEntities.some((entity) => entity.classname === "player")).toBe(true);
      const command = (sequence: number) => ({
        type: "input", protocolVersion: PROTOCOL_VERSION, worldEpoch: game.worldEpoch,
        sequence, clientTick: sequence, moveX: 1, moveZ: 0, lookYaw: 0, lookPitch: 0,
        buttons: 0, jumpCounter: 0, interactCounter: 0, primaryCounter: 0,
        interactTarget: null,
      } as const);
      expect(game.acceptInput(playerId, command(0))).toBe(true);
      expect(game.acceptInput(playerId, command(0))).toBe(true);
      for (let tick = 0; tick < 30; tick += 1) {
        expect(game.acceptInput(playerId, command(tick + 1))).toBe(true);
        game.advance(PHYSICS_DT);
      }
      const moved = game.snapshot().bodies.find((body) => key(body.id) === key(playerId))!;
      expect(moved.position.x).toBeGreaterThan(start.position.x + 1);
      for (let tick = 0; tick < INPUT_INTENT_TIMEOUT_TICKS + 2; tick += 1) game.advance(PHYSICS_DT);
      const expired = game.snapshot().bodies.find((body) => key(body.id) === key(playerId))!;
      for (let tick = 0; tick < 20; tick += 1) game.advance(PHYSICS_DT);
      const stopped = game.snapshot().bodies.find((body) => key(body.id) === key(playerId))!;
      expect(Math.abs(stopped.position.x - expired.position.x)).toBeLessThan(0.02);

      expect(game.disconnectPlayer(playerId)).toBe(true);
      expect(game.disconnectPlayer(playerId)).toBe(false);
      const replacement = game.connectPlayer();
      expect(replacement.index).toBe(playerId.index);
      expect(replacement.generation).toBe(playerId.generation + 1);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("coalesces a burst to current held intent without losing monotonic action edges", async () => {
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(store, () => {}, () => {});
    try {
      const playerId = game.connectPlayer();
      for (let tick = 0; tick < 120; tick += 1) game.advance(PHYSICS_DT);
      for (let sequence = 0; sequence < 300; sequence += 1) expect(game.acceptInput(playerId, {
        type: "input", protocolVersion: PROTOCOL_VERSION, worldEpoch: game.worldEpoch,
        sequence, clientTick: sequence, moveX: 1, moveZ: 0, lookYaw: 0, lookPitch: 0,
        buttons: sequence === 299 ? 1 : 0, jumpCounter: sequence === 299 ? 1 : 0,
        interactCounter: 0, interactTarget: null, primaryCounter: 0,
      })).toBe(true);
      game.advance(PHYSICS_DT);
      const player = game.snapshot().players.find((candidate) => key(candidate.id) === key(playerId))!;
      expect(player.lastProcessedInputSequence).toBe(299);
      expect(player.lastJumpCounter).toBe(1);
      expect(player.verticalVelocity).toBeGreaterThan(0);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("restores a persistent player controller by private session identity after restart", async () => {
    const store = new WorldStore(":memory:");
    const first = await AuthoritativeGame.create(store, () => {}, () => {});
    const persistentId = "hashed-private-session";
    const firstId = first.connectPlayer(persistentId);
    for (let sequence = 0; sequence < 45; sequence += 1) {
      first.acceptInput(firstId, {
        type: "input", protocolVersion: PROTOCOL_VERSION, worldEpoch: first.worldEpoch,
        sequence, clientTick: sequence, moveX: 1, moveZ: 0, lookYaw: 0.4, lookPitch: 0,
        buttons: 0, jumpCounter: 0, interactCounter: 0, primaryCounter: 0, interactTarget: null,
      });
      first.advance(PHYSICS_DT);
    }
    const before = first.playerPosition(firstId)!;
    first.stop();

    const restored = await AuthoritativeGame.create(store, () => {}, () => {});
    try {
      expect(restored.canResumePlayer(persistentId)).toBe(true);
      const restoredId = restored.connectPlayer(persistentId);
      expect(restored.playerPosition(restoredId)).toEqual(before);
      expect(restored.canResumePlayer(persistentId)).toBe(false);
    } finally {
      restored.stop();
      store.close();
    }
  });

  test("emits one final sleeping body delta and then keeps it silent", async () => {
    const store = new WorldStore(":memory:");
    const emitted: Snapshot[] = [];
    const game = await AuthoritativeGame.create(store, (snapshot) => emitted.push(snapshot), () => {});
    try {
      const cube = game.worldMessage().runtimeEntities.find((entity) => entity.authoredId === "physics.cube.heavy")!;
      for (let tick = 0; tick < 720; tick += 1) game.advance(PHYSICS_DT);
      const appearances = emitted.flatMap((snapshot) => snapshot.bodies
        .filter((body) => key(body.id) === key(cube.id))
        .map((body) => ({ tick: snapshot.serverTick, flags: body.flags ?? 0 })));
      const sleep = appearances.find((appearance) => (appearance.flags & SNAPSHOT_FLAG_SLEEP) !== 0);
      expect(sleep).toBeDefined();
      expect(emitted.filter((snapshot) => snapshot.serverTick > sleep!.tick + 3)
        .every((snapshot) => snapshot.bodies.every((body) => key(body.id) !== key(cube.id)))).toBe(true);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("replicates nearby prediction bodies at 20 Hz and staggers unrelated dirty bodies at 10 Hz", async () => {
    const store = new WorldStore(":memory:");
    const emitted: Snapshot[] = [];
    const game = await AuthoritativeGame.create(store, (snapshot) => emitted.push(snapshot), () => {}, {
      extraDynamicBodies: 3,
      playerSpawn: { x: 2, y: 0.9, z: -18 },
    });
    try {
      game.connectPlayer("replication-cadence");
      const runtime = game.worldMessage().runtimeEntities;
      const nearby = runtime.find((entity) => entity.authoredId === "stress.dynamic.000")!;
      const unrelated = runtime.find((entity) => entity.authoredId === "stress.dynamic.002")!;

      for (let tick = 0; tick < 6; tick += 1) game.advance(PHYSICS_DT);

      expect(emitted).toHaveLength(2);
      expect(emitted.every((snapshot) => snapshot.bodies.some((body) => key(body.id) === key(nearby.id)))).toBe(true);
      expect(emitted.filter((snapshot) => snapshot.bodies.some((body) => key(body.id) === key(unrelated.id)))).toHaveLength(1);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("builds a complete discontinuity snapshot for backpressure recovery", async () => {
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(store, () => {}, () => {}, { extraDynamicBodies: 3 });
    try {
      game.connectPlayer("backpressure-recovery");
      const snapshot = game.snapshot({ full: true, discontinuity: true });
      expect(snapshot.bodies).toHaveLength(game.worldMessage().runtimeEntities.length);
      expect(snapshot.bodies.every((body) => ((body.flags ?? 0) & SNAPSHOT_FLAG_TELEPORT) !== 0)).toBe(true);
    } finally {
      game.stop();
      store.close();
    }
  });
});
