import { describe, expect, test } from "bun:test";
import { compileWorld, type WorldBundle } from "@gurgur/game";
import {
  PHYSICS_DT,
  NETWORK_FLAG_ACTIVE,
  NETWORK_FLAG_HELD,
  PROTOCOL_VERSION,
  SourceTickMapper,
  type InputCommand,
  type ManipulationRequestMessage,
  type NetworkBodyState,
  type NetworkPlayerState,
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
      expect(game.acceptOwnedStates(player, [published, published])).toBeNull();
      expect(game.acceptOwnedStates(player, [published])).not.toBeNull();
      expect(game.playerPosition(player)).toEqual(published.position);
      expect(game.acceptOwnedStates(player, [published])).toBeNull();
      expect(game.acceptOwnedStates(player, [published], true)).not.toBeNull();
      expect(game.acceptOwnedStates(player, [{ ...published, stateSequence: 0 }])).toBeNull();

      for (let tick = 0; tick < 10; tick += 1) game.advance(PHYSICS_DT);
      expect(
        game.acceptOwnedStates(player, [
          {
            ...published,
            stateSequence: 2,
            sourceTick: (published.sourceTick + 2) >>> 0,
          },
        ]),
      ).not.toBeNull();
      expect(game.metrics().maxStateAgeMs).toBeGreaterThan(100);
      expect(
        game.acceptOwnedStates(player, [
          {
            ...published,
            stateSequence: 3,
            sourceTick: published.sourceTick + SourceTickMapper.MAX_FUTURE_LEAD_TICKS + 1_000,
          },
        ]),
      ).toBeNull();
    } finally {
      game.stop();
      store.close();
    }
  });

  test("keeps every loose prop Bun-owned and rejects browser-authored body state", async () => {
    const bundle = await fixture("network-push-corridor");
    const store = new WorldStore(":memory:");
    const game = await WorldHost.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    try {
      const player = game.connectPlayer("body-state-attacker");
      const target = runtimeId(game, "corridor.light");
      const targetState = bodyState(game, target);
      expect(descriptorFor(game, target).transferPolicy).toBe("fixed");
      expect(descriptorFor(game, target).ownerPlayerId).toBeNull();
      expect(
        game.acceptOwnedStates(player, [
          {
            ...targetState,
            stateSequence: targetState.stateSequence + 1,
            position: { x: 9_000, y: 9_000, z: 9_000 },
          },
        ]),
      ).toBeNull();
      for (let tick = 0; tick < 120; tick += 1) game.advance(PHYSICS_DT);
      expect(descriptorFor(game, target).ownerPlayerId).toBeNull();
      expect(descriptorFor(game, target).authorityVersion).toBe(targetState.authorityVersion);
      expect(bodyState(game, target).position.x).not.toBe(9_000);
    } finally {
      game.stop();
      store.close();
    }
  });

  test("drives a loose grab through one host control claim without authority transfer", async () => {
    const bundle = await fixture("network-push-corridor");
    const store = new WorldStore(":memory:");
    const published: NetworkBodyState[][] = [];
    const game = await WorldHost.create(
      store,
      (states) =>
        published.push(states.filter((state): state is NetworkBodyState => state.kind === "body")),
      () => {},
      { worldBundle: bundle },
    );
    try {
      const player = game.connectPlayer("host-grabber");
      const competitor = game.connectPlayer("competing-grabber");
      const target = runtimeId(game, "corridor.light");
      const initial = bodyState(game, target);
      placePlayer(game, player, initial.position, 1);
      placePlayer(game, competitor, initial.position, 1);
      const request = manipulationRequest(game, target, initial.authorityVersion, 7);
      const granted = game.requestManipulation(player, request);
      if (typeof granted === "string") throw new Error(granted);
      expect(game.requestManipulation(competitor, { ...request, requestId: 8 })).toBe("busy");
      expect(descriptorFor(game, target).ownerPlayerId).toBeNull();
      expect(descriptorFor(game, target).authorityVersion).toBe(initial.authorityVersion);
      expect(
        game.acceptManipulationState(player, {
          worldEpoch: game.worldEpoch,
          target,
          authorityVersion: initial.authorityVersion,
          claimVersion: granted.claimVersion,
          stateSequence: 1,
          targetPosition: {
            x: initial.position.x,
            y: initial.position.y + 1,
            z: initial.position.z,
          },
          targetRotation: initial.rotation,
        }),
      ).toBe(true);
      for (let tick = 0; tick < 4; tick += 1) game.advance(PHYSICS_DT);
      const hotTicks = published.flatMap((states) =>
        states.filter((state) => key(state.id) === key(target)).map((state) => state.sourceTick),
      );
      expect(hotTicks).toHaveLength(4);
      expect(new Set(hotTicks).size).toBe(4);
      for (let tick = 0; tick < 30; tick += 1) game.advance(PHYSICS_DT);
      const controlled = bodyState(game, target);
      expect(controlled.position.y).toBeGreaterThan(initial.position.y);
      const changed = game.dropManipulation(player, {
        type: "manipulation-drop",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: game.worldEpoch,
        target,
        authorityVersion: granted.authorityVersion,
        claimVersion: granted.claimVersion,
      });
      expect(changed).not.toBeNull();
      expect(changed!.manipulatorPlayerId).toBeNull();
      const releasedY = controlled.position.y;
      game.advance(PHYSICS_DT);
      expect(bodyState(game, target).position.y).not.toBe(releasedY);
      expect(descriptorFor(game, target).ownerPlayerId).toBeNull();
    } finally {
      game.stop();
      store.close();
    }
  });

  test("ends a loose-prop claim on disconnect and permits a new first-wins claim", async () => {
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
      const grant = game.requestManipulation(
        disconnected,
        manipulationRequest(game, target, initial.authorityVersion, 10),
      );
      if (typeof grant === "string") throw new Error(grant);

      const reclaimed = game.endManipulationsForPlayer(disconnected);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.manipulatorPlayerId).toBeNull();
      const takeover = game.requestManipulation(
        successor,
        manipulationRequest(game, target, initial.authorityVersion, 11),
      );
      expect(typeof takeover).not.toBe("string");
      if (typeof takeover === "string") throw new Error(takeover);
      expect(takeover.manipulatorPlayerId).toEqual(successor);
      expect(descriptorFor(game, target).ownerPlayerId).toBeNull();
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
      ).toBeNull();

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

  test("keeps compiled contraption graphs fixed and rebuilds them across reset", async () => {
    const path = "content/maps/fixtures/physics-contraptions.map";
    const bundle = compileWorld(await Bun.file(path).text(), path);
    const store = new WorldStore(":memory:");
    const game = await WorldHost.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    try {
      const world = game.worldMessage();
      const bodyDescriptors = world.runtimeEntities.filter(
        (entity) => entity.kind === "world-entity",
      );
      for (const descriptor of bodyDescriptors) {
        expect(descriptor.transferPolicy).toBe("fixed");
      }
      expect(
        descriptorFor(game, runtimeId(game, "fixture.trebuchet.projectile")).transferPolicy,
      ).toBe("fixed");
      const conveyor = runtimeId(game, "fixture.conveyor");
      expect(bodyState(game, conveyor).flags & NETWORK_FLAG_ACTIVE).toBe(NETWORK_FLAG_ACTIVE);
      for (let tick = 0; tick < 180; tick += 1) game.advance(PHYSICS_DT);
      expect(
        game
          .snapshot()
          .bodies.every((body) =>
            [...Object.values(body.position), ...Object.values(body.rotation)].every(
              Number.isFinite,
            ),
          ),
      ).toBe(true);
      const oldEpoch = game.worldEpoch;
      game.reset();
      expect(game.worldEpoch).toBe(oldEpoch + 1);
      expect(bodyState(game, runtimeId(game, "fixture.conveyor")).flags & NETWORK_FLAG_ACTIVE).toBe(
        NETWORK_FLAG_ACTIVE,
      );
    } finally {
      game.stop();
      store.close();
    }
  });

  test("manipulates a jointed body on the host with an exclusive disposable claim", async () => {
    const path = "content/maps/fixtures/physics-contraptions.map";
    const bundle = compileWorld(await Bun.file(path).text(), path);
    const store = new WorldStore(":memory:");
    const game = await WorldHost.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    try {
      const first = game.connectPlayer("lever-first");
      const second = game.connectPlayer("lever-second");
      const target = runtimeId(game, "fixture.lever.body");
      const initial = bodyState(game, target);
      placePlayer(game, first, initial.position, 1);
      placePlayer(game, second, initial.position, 1);
      const request: ManipulationRequestMessage = {
        type: "manipulation-request",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: game.worldEpoch,
        requestId: 31,
        target,
        authorityVersion: initial.authorityVersion,
        localAnchor: { x: 0, y: 0, z: 0 },
        holdDistance: 1.5,
      };
      const granted = game.requestManipulation(first, request);
      expect(typeof granted).not.toBe("string");
      if (typeof granted === "string") throw new Error(granted);
      expect(granted.manipulatorPlayerId).toEqual(first);
      expect(game.requestManipulation(second, { ...request, requestId: 32 })).toBe("busy");
      expect(bodyState(game, target).flags & NETWORK_FLAG_HELD).toBe(NETWORK_FLAG_HELD);
      expect(
        game.acceptManipulationState(first, {
          worldEpoch: game.worldEpoch,
          target,
          authorityVersion: initial.authorityVersion,
          claimVersion: granted.claimVersion,
          stateSequence: 1,
          targetPosition: {
            x: initial.position.x,
            y: initial.position.y + 0.75,
            z: initial.position.z,
          },
          targetRotation: { x: 0, y: 0, z: 0, w: 1 },
        }),
      ).toBe(true);
      expect(
        game.acceptManipulationState(second, {
          worldEpoch: game.worldEpoch,
          target,
          authorityVersion: initial.authorityVersion,
          claimVersion: granted.claimVersion,
          stateSequence: 2,
          targetPosition: initial.position,
          targetRotation: initial.rotation,
        }),
      ).toBe(false);
      game.advance(PHYSICS_DT);
      const released = game.endManipulationsForPlayer(first);
      expect(released).toHaveLength(1);
      expect(released[0]!.manipulatorPlayerId).toBeNull();
      expect(bodyState(game, target).flags & NETWORK_FLAG_HELD).toBe(0);
      expect(descriptorFor(game, target).ownerPlayerId).toBeNull();
      expect(descriptorFor(game, target).authorityVersion).toBe(initial.authorityVersion);
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

function manipulationRequest(
  game: WorldHost,
  target: RuntimeId,
  authorityVersion: number,
  requestId: number,
): ManipulationRequestMessage {
  return {
    type: "manipulation-request",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: game.worldEpoch,
    requestId,
    target: { ...target },
    authorityVersion,
    holdDistance: 2,
    localAnchor: { x: 0, y: 0, z: 0 },
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
  ).not.toBeNull();
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
