import { describe, expect, test } from "bun:test";
import { compileWorld, type WorldBundle } from "@gurgur/game";
import {
  PHYSICS_DT,
  PROTOCOL_VERSION,
  type InputCommand,
  type NetworkBodyState,
  type NetworkPlayerState,
  type OwnershipRequestMessage,
  type RuntimeId,
} from "@gurgur/engine";
import { WorldHost } from "../src/game";
import { WorldStore } from "../src/store";

const fixtures = [
  "network-boxes",
  "network-push-corridor",
  "network-stack-tower",
  "network-domino-field",
] as const;

describe("per-object authority host", () => {
  test("loads every interaction fixture and simulates every unowned body at fixed steps", async () => {
    for (const name of fixtures) {
      const bundle = await fixture(name);
      const store = new WorldStore(":memory:");
      const game = await WorldHost.create(
        store,
        () => {},
        () => {},
        { worldBundle: bundle },
      );
      try {
        const expectedBodies = bundle.entities.filter((entity) => entity.body !== null).length;
        expect(game.worldMessage().runtimeEntities).toHaveLength(expectedBodies);
        for (let tick = 0; tick < 360; tick += 1) game.advance(PHYSICS_DT);
        const snapshot = game.snapshot();
        expect(snapshot.bodies).toHaveLength(expectedBodies);
        for (const snapshotBody of snapshot.bodies) {
          expect(
            [
              ...Object.values(snapshotBody.position),
              ...Object.values(snapshotBody.rotation),
              ...Object.values(snapshotBody.linearVelocity ?? {}),
              ...Object.values(snapshotBody.angularVelocity ?? {}),
            ].every(Number.isFinite),
          ).toBe(true);
          expect(snapshotBody.position.y).toBeGreaterThan(-0.1);
        }
      } finally {
        game.stop();
        store.close();
      }
    }
  });

  test("accepts browser-owned player state and never advances that player from host input", async () => {
    const store = new WorldStore(":memory:");
    const game = await WorldHost.create(
      store,
      () => {},
      () => {},
    );
    try {
      const player = game.connectPlayer("browser-player");
      const initial = playerState(game, player);
      expect(game.acceptInput(player, input(game, 1))).toBe(false);
      for (let tick = 0; tick < 30; tick += 1) game.advance(PHYSICS_DT);
      expect(game.playerPosition(player)).toEqual(initial.position);

      const published = {
        ...initial,
        stateSequence: 1,
        position: { x: initial.position.x + 3, y: initial.position.y, z: initial.position.z },
        yaw: 0.75,
      };
      expect(game.acceptOwnedStates(player, [published])).toBe(true);
      expect(game.playerPosition(player)).toEqual(published.position);
      expect(game.acceptOwnedStates(player, [{ ...published, stateSequence: 0 }])).toBe(false);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("gives a grab lease to the first valid requester and contact never transfers it", async () => {
    const bundle = await fixture("network-push-corridor");
    const store = new WorldStore(":memory:");
    const game = await WorldHost.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    try {
      const first = game.connectPlayer("first-grabber");
      const second = game.connectPlayer("second-grabber");
      const target = runtimeId(game, "corridor.light");
      const targetState = bodyState(game, target);
      placePlayer(game, first, targetState.position, 1);
      placePlayer(game, second, targetState.position, 1);

      const request = ownershipRequest(game, target, targetState.authorityVersion);
      const granted = game.requestOwnership(first, request);
      expect(typeof granted).not.toBe("string");
      if (typeof granted === "string") throw new Error(granted);
      expect(granted.ownerPlayerId).toEqual(first);
      expect(granted.authorityVersion).toBe(targetState.authorityVersion + 1);
      expect(game.requestOwnership(second, { ...request, requestId: 2 })).toBe("stale");

      const heldPosition = { ...granted.state.position };
      for (let tick = 0; tick < 120; tick += 1) game.advance(PHYSICS_DT);
      const descriptor = descriptorFor(game, target);
      expect(descriptor.ownerPlayerId).toEqual(first);
      expect(bodyState(game, target).position).toEqual(heldPosition);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("rejects stale-owner state and preserves release velocity through host takeover", async () => {
    const bundle = await fixture("network-push-corridor");
    const store = new WorldStore(":memory:");
    const game = await WorldHost.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    try {
      const player = game.connectPlayer("release-player");
      const target = runtimeId(game, "corridor.light");
      const initial = bodyState(game, target);
      placePlayer(game, player, initial.position, 1);
      const grant = game.requestOwnership(
        player,
        ownershipRequest(game, target, initial.authorityVersion),
      );
      if (typeof grant === "string") throw new Error(grant);
      if (grant.state.kind !== "body") throw new Error("prop grant returned player state");
      const owned: NetworkBodyState = {
        ...grant.state,
        stateSequence: 7,
        position: { x: initial.position.x, y: initial.position.y + 1, z: initial.position.z },
        linearVelocity: { x: 3, y: 0, z: 0 },
      };
      expect(game.acceptOwnedStates(player, [owned])).toBe(true);
      const changed = game.dropOwnership(player, {
        worldEpoch: game.worldEpoch,
        id: target,
        authorityVersion: grant.authorityVersion,
        state: owned,
      });
      expect(changed).not.toBeNull();
      expect(changed!.ownerPlayerId).toBeNull();
      expect(changed!.state.linearVelocity.x).toBeCloseTo(3, 5);
      expect(game.acceptOwnedStates(player, [{ ...owned, stateSequence: 8 }])).toBe(false);
      const releasedX = changed!.state.position.x;
      game.advance(PHYSICS_DT);
      expect(bodyState(game, target).position.x).toBeGreaterThan(releasedX);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("reclaims a held prop on disconnect and permits a new first-wins lease", async () => {
    const bundle = await fixture("network-push-corridor");
    const store = new WorldStore(":memory:");
    const game = await WorldHost.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    try {
      const disconnected = game.connectPlayer("disconnect-holder");
      const successor = game.connectPlayer("successor");
      const target = runtimeId(game, "corridor.light");
      const initial = bodyState(game, target);
      placePlayer(game, disconnected, initial.position, 1);
      placePlayer(game, successor, initial.position, 1);
      const grant = game.requestOwnership(
        disconnected,
        ownershipRequest(game, target, initial.authorityVersion),
      );
      if (typeof grant === "string") throw new Error(grant);

      const reclaimed = game.reclaimOwnedBy(disconnected);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.ownerPlayerId).toBeNull();
      const takeover = game.requestOwnership(
        successor,
        ownershipRequest(game, target, reclaimed[0]!.authorityVersion),
      );
      expect(typeof takeover).not.toBe("string");
      if (typeof takeover === "string") throw new Error(takeover);
      expect(takeover.ownerPlayerId).toEqual(successor);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("reconnect and reset publish fresh player authority assignments", async () => {
    const store = new WorldStore(":memory:");
    const worlds: number[] = [];
    const game = await WorldHost.create(
      store,
      () => {},
      (world) => worlds.push(world.worldEpoch),
    );
    try {
      const player = game.connectPlayer("reconnect-player");
      const initial = playerState(game, player);
      const reassigned = game.reassignPlayer(player);
      expect(reassigned?.authorityVersion).toBe(initial.authorityVersion + 1);
      expect(
        game.acceptOwnedStates(player, [
          { ...initial, stateSequence: 1, authorityVersion: initial.authorityVersion },
        ]),
      ).toBe(false);

      const oldEpoch = game.worldEpoch;
      game.reset();
      expect(game.worldEpoch).toBe(oldEpoch + 1);
      expect(worlds).toEqual([oldEpoch + 1]);
      expect(playerState(game, player).authorityVersion).toBe(reassigned!.authorityVersion + 1);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("keeps the 16-player/128-prop host tick budget", async () => {
    const store = new WorldStore(":memory:");
    const game = await WorldHost.create(
      store,
      () => {},
      () => {},
      {
        extraDynamicBodies: 122,
      },
    );
    try {
      for (let index = 0; index < 16; index += 1) game.connectPlayer(`budget-${index}`);
      for (let tick = 0; tick < 600; tick += 1) game.advance(PHYSICS_DT);
      expect(game.bootstrapStates().filter((state) => state.kind === "player")).toHaveLength(16);
      const metrics = game.metrics();
      expect(metrics.tickP95Ms).toBeLessThan(8);
      expect(metrics.tickP99Ms).toBeLessThan(12);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("persists bodies by authored identity and invalidates runtime generations on reset", async () => {
    const bundle = await fixture("network-domino-field");
    const store = new WorldStore(":memory:");
    const first = await WorldHost.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    for (let tick = 0; tick < 240; tick += 1) first.advance(PHYSICS_DT);
    const saved = first.snapshot();
    const oldIds = new Set(first.worldMessage().runtimeEntities.map(({ id }) => key(id)));
    first.stop();

    const restored = await WorldHost.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
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

function ownershipRequest(
  game: WorldHost,
  target: RuntimeId,
  authorityVersion: number,
): OwnershipRequestMessage {
  return {
    type: "ownership-request",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: game.worldEpoch,
    requestId: 1,
    target: { ...target },
    authorityVersion,
    holdDistance: 2,
    relativeRotation: { x: 0, y: 0, z: 0, w: 1 },
  };
}

function input(game: WorldHost, sequence: number): InputCommand {
  return {
    type: "input" as const,
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: game.worldEpoch,
    sequence,
    clientTick: sequence,
    moveX: 1,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    jumpCounter: 0,
    interactCounter: 0,
    interactTarget: null,
    primaryCounter: 0,
  };
}

function placePlayer(
  game: WorldHost,
  id: RuntimeId,
  position: NetworkPlayerState["position"],
  sequence: number,
) {
  const current = playerState(game, id);
  expect(
    game.acceptOwnedStates(id, [
      {
        ...current,
        stateSequence: sequence,
        position: { ...position },
      },
    ]),
  ).toBe(true);
}

function playerState(game: WorldHost, id: RuntimeId): NetworkPlayerState {
  const state = game
    .bootstrapStates()
    .find(
      (candidate): candidate is NetworkPlayerState =>
        candidate.kind === "player" && same(candidate.id, id),
    );
  if (!state) throw new Error("player state is unavailable");
  return structuredClone(state);
}

function bodyState(game: WorldHost, id: RuntimeId): NetworkBodyState {
  const state = game
    .bootstrapStates()
    .find(
      (candidate): candidate is NetworkBodyState =>
        candidate.kind === "body" && same(candidate.id, id),
    );
  if (!state) throw new Error("body state is unavailable");
  return structuredClone(state);
}

function descriptorFor(game: WorldHost, id: RuntimeId) {
  const descriptor = game
    .worldMessage()
    .runtimeEntities.find((candidate) => same(candidate.id, id));
  if (!descriptor) throw new Error("runtime descriptor is unavailable");
  return descriptor;
}

function runtimeId(game: WorldHost, authoredId: string): RuntimeId {
  const world = game.worldMessage();
  const runtime = world.runtimeEntities.find(
    (candidate) =>
      candidate.kind === "world-entity" &&
      world.bundle.entities[candidate.entityIndex]?.authoredId === authoredId,
  );
  if (!runtime) throw new Error(`runtime entity is unavailable: ${authoredId}`);
  return { ...runtime.id };
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
