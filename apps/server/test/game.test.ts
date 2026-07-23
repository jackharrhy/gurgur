import { describe, expect, test } from "bun:test";
import { PLAYER_HALF_HEIGHT } from "@gurgur/physics";
import {
  FAR_BODY_SNAPSHOT_STRIDE,
  FULL_RATE_BODY_RADIUS_METRES,
  INPUT_INTENT_TIMEOUT_TICKS,
  PHYSICS_DT,
  PHYSICS_HZ,
  PROTOCOL_VERSION,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_GRABBED,
  SNAPSHOT_FLAG_TELEPORT,
  SNAPSHOT_INTERVAL_TICKS,
  type InputCommand,
  type RuntimeId,
  type Snapshot,
  type WorldBundle,
} from "@gurgur/shared";
import { compileWorld } from "@gurgur/world-compiler";
import { AuthoritativeGame } from "../src/game";
import { WorldStore } from "../src/store";

const fixtures = [
  "network-boxes",
  "network-push-corridor",
  "network-stack-tower",
  "network-domino-field",
] as const;

describe("authoritative network physics", () => {
  test("loads every authored interaction fixture and settles one finite Box3D world", async () => {
    for (const name of fixtures) {
      const bundle = await fixture(name);
      const store = new WorldStore(":memory:");
      const game = await AuthoritativeGame.create(
        store,
        () => {},
        () => {},
        { worldBundle: bundle },
      );
      try {
        const expectedBodies = bundle.entities.filter((entity) =>
          ["func_physics", "func_door", "func_platform", "func_button"].includes(entity.classname),
        ).length;
        expect(game.worldMessage().runtimeEntities).toHaveLength(expectedBodies);
        for (let tick = 0; tick < 360; tick += 1) game.advance(PHYSICS_DT);
        const snapshot = game.snapshot();
        expect(snapshot.bodies).toHaveLength(expectedBodies);
        for (const bodyState of snapshot.bodies) {
          expect(
            [
              ...Object.values(bodyState.position),
              ...Object.values(bodyState.rotation),
              ...Object.values(bodyState.linearVelocity ?? {}),
              ...Object.values(bodyState.angularVelocity ?? {}),
            ].every(Number.isFinite),
          ).toBe(true);
          expect(bodyState.position.y).toBeGreaterThan(-0.1);
        }
      } finally {
        game.stop();
        store.close();
      }
    }
  });

  test("pushes a light prop only in the server simulation", async () => {
    const bundle = await fixture("network-push-corridor");
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    try {
      const player = game.connectPlayer("push-player");
      const light = runtimeId(game, "corridor.light");
      for (let tick = 0; tick < 90; tick += 1) game.advance(PHYSICS_DT);
      const before = body(game.snapshot(), light).position.x;
      for (let sequence = 0; sequence < 180; sequence += 1) {
        game.acceptInput(player, command(game, sequence, { moveX: 1, lookYaw: 0 }));
        game.advance(PHYSICS_DT);
      }
      expect(body(game.snapshot(), light).position.x).toBeGreaterThan(before + 0.35);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("replicates authoritative grab ownership until the player releases it", async () => {
    const bundle = await fixture("network-push-corridor");
    const heavyEntity = bundle.entities.find(
      (entity) => entity.authoredId === "corridor.heavy" && entity.classname === "func_physics",
    )!;
    const heavyBrush = bundle.brushes[heavyEntity.brushIndices[0]!]!;
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      {
        worldBundle: bundle,
        playerSpawn: {
          x: heavyBrush.center.x,
          y: PLAYER_HALF_HEIGHT,
          z: heavyBrush.center.z + 2.5,
        },
      },
    );
    try {
      const player = game.connectPlayer("grab-player");
      const heavy = runtimeId(game, "corridor.heavy");
      for (let tick = 0; tick < 90; tick += 1) game.advance(PHYSICS_DT);

      game.acceptInput(
        player,
        command(game, 0, {
          lookPitch: -0.18,
          interactTarget: heavy,
          primaryCounter: 1,
        }),
      );
      game.advance(PHYSICS_DT);
      expect(game.grabbedTarget(player)).toEqual(heavy);
      expect((body(game.snapshot(), heavy).flags ?? 0) & SNAPSHOT_FLAG_GRABBED).toBe(
        SNAPSHOT_FLAG_GRABBED,
      );

      game.acceptInput(player, command(game, 1, { primaryCounter: 2 }));
      game.advance(PHYSICS_DT);
      expect(game.grabbedTarget(player)).toBeNull();
      expect((body(game.snapshot(), heavy).flags ?? 0) & SNAPSHOT_FLAG_GRABBED).toBe(0);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("applies only the newest intent in a burst and preserves monotonic action counters", async () => {
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
    );
    try {
      const player = game.connectPlayer("latest-intent");
      for (let tick = 0; tick < 120; tick += 1) game.advance(PHYSICS_DT);
      for (let sequence = 0; sequence < 300; sequence += 1) {
        expect(
          game.acceptInput(
            player,
            command(game, sequence, {
              moveX: sequence === 299 ? 1 : -1,
              buttons: sequence === 299 ? 1 : 0,
              jumpCounter: sequence === 299 ? 1 : 0,
            }),
          ),
        ).toBe(true);
      }
      game.advance(PHYSICS_DT);
      const state = game.snapshot().players.find((candidate) => same(candidate.id, player))!;
      expect(state.lastProcessedInputSequence).toBe(299);
      expect(state.lastJumpCounter).toBe(1);
      expect(state.verticalVelocity).toBeGreaterThan(0);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("expires a missing held intent quickly instead of walking for three quarters of a second", async () => {
    const bundle = await fixture("network-push-corridor");
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    try {
      const player = game.connectPlayer("input-timeout");
      for (let tick = 0; tick < 90; tick += 1) game.advance(PHYSICS_DT);
      game.acceptInput(player, command(game, 0, { moveZ: 1 }));
      for (let tick = 0; tick < INPUT_INTENT_TIMEOUT_TICKS + 1; tick += 1) game.advance(PHYSICS_DT);
      const expired = game.playerPosition(player)!;
      for (let tick = 0; tick < 30; tick += 1) game.advance(PHYSICS_DT);
      const stopped = game.playerPosition(player)!;
      expect(Math.hypot(stopped.x - expired.x, stopped.z - expired.z)).toBeLessThan(0.03);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("respawns an authoritative player that falls below map collision", async () => {
    const bundle = await fixture("network-push-corridor");
    const emitted: Snapshot[] = [];
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      (snapshot) => emitted.push(snapshot),
      () => {},
      {
        worldBundle: bundle,
        playerSpawn: { x: 1_000, y: 1, z: 1_000 },
      },
    );
    try {
      const player = game.connectPlayer("void-recovery");
      for (let tick = 0; tick < 360; tick += 1) game.advance(PHYSICS_DT);
      const samples = emitted.flatMap((snapshot) =>
        snapshot.bodies.filter((candidate) => same(candidate.id, player)),
      );
      expect(samples.length).toBeGreaterThan(30);
      const firstTeleport = samples.findIndex(
        ({ flags }) => ((flags ?? 0) & SNAPSHOT_FLAG_TELEPORT) !== 0,
      );
      expect(firstTeleport).toBeGreaterThanOrEqual(0);
      expect(
        samples
          .slice(firstTeleport, firstTeleport + 5)
          .every(({ flags }) => ((flags ?? 0) & SNAPSHOT_FLAG_TELEPORT) !== 0),
      ).toBe(true);
      expect(
        samples.every(({ position }) =>
          [position.x, position.y, position.z].every(Number.isFinite),
        ),
      ).toBe(true);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("sends nearby awake props at 30 Hz and staggered remote props at 5 Hz", async () => {
    const bundle = await fixture("network-domino-field");
    const withoutPlayer = await cadence(bundle, false);
    const withPlayer = await cadence(bundle, true);
    const runtimeCount = bundle.entities.filter(
      (entity) => entity.classname === "func_physics",
    ).length;
    expect(withoutPlayer).toHaveLength(FAR_BODY_SNAPSHOT_STRIDE);
    expect(withoutPlayer.reduce((sum, snapshot) => sum + snapshot.bodies.length, 0)).toBe(
      runtimeCount,
    );
    expect(withPlayer).toHaveLength(FAR_BODY_SNAPSHOT_STRIDE);
    expect(withPlayer.every((snapshot) => snapshot.bodies.length === runtimeCount + 1)).toBe(true);
    expect(FULL_RATE_BODY_RADIUS_METRES).toBeGreaterThan(0);
  });

  test("repeats terminal sleep state for loss recovery and then leaves dormant props silent", async () => {
    const bundle = await fixture("network-stack-tower");
    const emitted: Snapshot[] = [];
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      (snapshot) => emitted.push(snapshot),
      () => {},
      { worldBundle: bundle },
    );
    try {
      for (let tick = 0; tick < 1_200; tick += 1) game.advance(PHYSICS_DT);
      const connectionSnapshot = game.snapshot({ full: true });
      for (const runtime of game.worldMessage().runtimeEntities) {
        const appearances = emitted.flatMap((snapshot) =>
          snapshot.bodies
            .filter((candidate) => same(candidate.id, runtime.id))
            .map((candidate) => ({ tick: snapshot.serverTick, flags: candidate.flags ?? 0 })),
        );
        const slept = appearances.find(
          (appearance) => (appearance.flags & SNAPSHOT_FLAG_SLEEP) !== 0,
        );
        expect(slept).toBeDefined();
        expect(
          appearances.filter((appearance) => appearance.tick > slept!.tick).length,
        ).toBeGreaterThan(2);
        expect(
          appearances.every(
            (appearance) => appearance.tick <= slept!.tick + PHYSICS_HZ + SNAPSHOT_INTERVAL_TICKS,
          ),
        ).toBe(true);
        expect(
          connectionSnapshot.bodies.find((candidate) => same(candidate.id, runtime.id))!.flags! &
            SNAPSHOT_FLAG_SLEEP,
        ).toBe(SNAPSHOT_FLAG_SLEEP);
      }
    } finally {
      game.stop();
      store.close();
    }
  });

  test("persists bodies by authored identity and invalidates runtime generations on reset", async () => {
    const bundle = await fixture("network-domino-field");
    const store = new WorldStore(":memory:");
    const first = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    for (let tick = 0; tick < 240; tick += 1) first.advance(PHYSICS_DT);
    const saved = first.snapshot();
    const oldIds = new Set(first.worldMessage().runtimeEntities.map(({ id }) => key(id)));
    first.stop();

    const restored = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      {
        worldBundle: bundle,
      },
    );
    try {
      expect(restored.snapshot().bodies.map(({ position }) => position)).toEqual(
        saved.bodies.map(({ position }) => position),
      );
      const reset = restored.reset();
      expect(restored.worldEpoch).toBe(saved.worldEpoch + 1);
      expect(restored.worldMessage().runtimeEntities.every(({ id }) => !oldIds.has(key(id)))).toBe(
        true,
      );
      expect(reset.bodies).toHaveLength(restored.worldMessage().runtimeEntities.length);
    } finally {
      restored.stop();
      store.close();
    }
  });
});

async function cadence(bundle: WorldBundle, connectPlayer: boolean): Promise<Snapshot[]> {
  const emitted: Snapshot[] = [];
  const store = new WorldStore(":memory:");
  const game = await AuthoritativeGame.create(
    store,
    (snapshot) => emitted.push(snapshot),
    () => {},
    { worldBundle: bundle },
  );
  try {
    if (connectPlayer) game.connectPlayer("cadence");
    for (let tick = 0; tick < SNAPSHOT_INTERVAL_TICKS * FAR_BODY_SNAPSHOT_STRIDE; tick += 1)
      game.advance(PHYSICS_DT);
    return emitted;
  } finally {
    game.stop();
    store.close();
  }
}

function command(
  game: AuthoritativeGame,
  sequence: number,
  overrides: Partial<InputCommand> = {},
): InputCommand {
  return {
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: game.worldEpoch,
    sequence,
    clientTick: sequence,
    moveX: 0,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    jumpCounter: 0,
    interactCounter: 0,
    interactTarget: null,
    primaryCounter: 0,
    ...overrides,
  };
}

function runtimeId(game: AuthoritativeGame, authoredId: string): RuntimeId {
  return game.worldMessage().runtimeEntities.find((entity) => entity.authoredId === authoredId)!.id;
}

function body(snapshot: Snapshot, id: RuntimeId) {
  return snapshot.bodies.find((candidate) => same(candidate.id, id))!;
}

function same(left: RuntimeId, right: RuntimeId): boolean {
  return left.index === right.index && left.generation === right.generation;
}

function key(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}

async function fixture(name: (typeof fixtures)[number]): Promise<WorldBundle> {
  const path = `content/maps/fixtures/${name}.map`;
  return compileWorld(await Bun.file(path).text(), path);
}
