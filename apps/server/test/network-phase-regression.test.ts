import { describe, expect, test } from "bun:test";
import { PLAYER_HALF_HEIGHT, compileWorld } from "@gurgur/game";
import {
  INPUT_REDUNDANCY,
  PHYSICS_DT,
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL_TICKS,
  acknowledgeState,
  decodeInputPacket,
  decodeSnapshot,
  encodeInputBundle,
  encodeSnapshot,
  type InputCommand,
  type RuntimeId,
  type StateAcknowledgement,
} from "@gurgur/engine";
import { PlayerPredictor } from "../../web/src/prediction";
import { AuthoritativeGame } from "../src/game";
import { ClientSnapshotScheduler } from "../src/snapshot-scheduler";
import { WorldStore } from "../src/store";

const fixturePath = new URL("../../../content/maps/fixtures/network-boxes.map", import.meta.url);
const FIXED_STEP_MS = PHYSICS_DT * 1_000;

describe("phase-independent predicted physics regression", () => {
  test("does not turn latest-intent acknowledgement cadence into simulation time", async () => {
    const bundle = compileWorld(await Bun.file(fixturePath).text(), "network-boxes.map");
    const allCorrections: number[] = [];
    const acknowledgementDeltas = new Set<number>();

    for (const clientPhaseMs of [0, 3, 8, 13]) {
      const store = new WorldStore(":memory:");
      const game = await AuthoritativeGame.create(
        store,
        () => {},
        () => {},
        { worldBundle: bundle },
      );
      const predictor = new PlayerPredictor(() => {});
      try {
        for (let tick = 0; tick < 90; tick += 1) game.advance(PHYSICS_DT);
        const playerId = game.connectPlayer(`phase-${clientPhaseMs}`);
        predictor.setLocalPlayer(playerId);
        await predictor.setWorld(game.worldMessage());
        predictor.reconcile(decodeSnapshot(encodeSnapshot(game.snapshot())));

        const result = simulateNetworkTimeline({
          game,
          playerId,
          predictor,
          clientPhaseMs,
          durationMs: 1_800,
          command: (sequence) =>
            input(game.worldEpoch, sequence, {
              moveX: 0.8,
              moveZ: 0.35,
              lookYaw: sequence * 0.002,
            }),
        });
        allCorrections.push(...result.corrections);
        for (const delta of result.acknowledgementDeltas) acknowledgementDeltas.add(delta);
      } finally {
        predictor.dispose();
        game.stop();
        store.close();
      }
    }

    expect(acknowledgementDeltas.has(0)).toBe(true);
    expect([...acknowledgementDeltas].some((delta) => delta >= 2)).toBe(true);
    expect(percentile(allCorrections, 0.95)).toBeLessThan(0.005);
    expect(percentile(allCorrections, 0.99)).toBeLessThan(0.01);
    expect(Math.max(...allCorrections)).toBeLessThan(0.02);
  });

  test("recreates grab, carry, turn, release, and throw under saturated state selection", async () => {
    const bundle = compileWorld(await Bun.file(fixturePath).text(), "network-boxes.map");
    const targetEntity = bundle.entities.find(
      (entity) => entity.authoredId === "fixture.push" && entity.kind === "physics-prop",
    )!;
    const targetBrush = bundle.brushes[targetEntity.body!.brushIndices[0]!]!;
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      {
        worldBundle: bundle,
        extraDynamicBodies: 32,
        playerSpawn: {
          x: targetBrush.center.x,
          y: PLAYER_HALF_HEIGHT,
          z: targetBrush.center.z + 2.5,
        },
      },
    );
    const predictor = new PlayerPredictor(() => {});
    const scheduler = new ClientSnapshotScheduler();
    try {
      for (let tick = 0; tick < 90; tick += 1) game.advance(PHYSICS_DT);
      const playerId = game.connectPlayer("phase-grab-throw");
      const targetId = runtimeId(game, "fixture.push");
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(game.worldMessage());
      predictor.reconcile(decodeSnapshot(encodeSnapshot(game.snapshot())));

      let acquired = false;
      let released = false;
      let releasePosition: { x: number; y: number; z: number } | null = null;
      let releaseVelocity: { x: number; y: number; z: number } | null = null;
      const selectedTargetTicks: number[] = [];
      const result = simulateNetworkTimeline({
        game,
        playerId,
        predictor,
        clientPhaseMs: 8,
        durationMs: 2_200,
        scheduler,
        command: (sequence, atMs) => {
          const releasing = atMs >= 900;
          const turn = Math.max(0, Math.min(1, (atMs - 250) / 500));
          return input(game.worldEpoch, sequence, {
            moveX: atMs < 900 ? 0.2 : 0,
            lookYaw: (Math.PI / 2) * turn,
            lookPitch: releasing ? 0 : -0.18,
            interactTarget: targetId,
            primaryCounter: releasing ? 2 : 1,
          });
        },
        onServerTick: () => {
          const held = game.grabbedTarget(playerId);
          if (held) acquired = true;
          if (acquired && !held && !released) {
            released = true;
            const target = bodyState(game, targetId);
            releasePosition = { ...target.position };
            releaseVelocity = { ...(target.linearVelocity ?? { x: 0, y: 0, z: 0 }) };
          }
        },
        onSelectedState: (serverTick, selected) => {
          const target = selected.bodies.find(({ id }) => sameId(id, targetId));
          if (target) selectedTargetTicks.push(serverTick);
        },
      });

      expect(acquired).toBe(true);
      expect(released).toBe(true);
      expect(releasePosition).not.toBeNull();
      expect(releaseVelocity).not.toBeNull();
      expect(Object.values(releaseVelocity!).every(Number.isFinite)).toBe(true);
      expect(releaseVelocity!.x).toBeLessThan(-0.1);
      const finalTarget = bodyState(game, targetId);
      expect(finalTarget.position.x).toBeLessThan(releasePosition!.x - 0.05);
      expect(selectedTargetTicks.length).toBeGreaterThan(20);
      expect(maximumGap(selectedTargetTicks)).toBeLessThanOrEqual(SNAPSHOT_INTERVAL_TICKS);
      expect(percentile(result.corrections, 0.99)).toBeLessThan(0.02);
    } finally {
      predictor.dispose();
      game.stop();
      store.close();
    }
  });
});

function simulateNetworkTimeline(options: {
  game: AuthoritativeGame;
  playerId: RuntimeId;
  predictor: PlayerPredictor;
  clientPhaseMs: number;
  durationMs: number;
  scheduler?: ClientSnapshotScheduler;
  command(sequence: number, atMs: number): InputCommand;
  onServerTick?(): void;
  onSelectedState?(serverTick: number, snapshot: ReturnType<AuthoritativeGame["snapshot"]>): void;
}): { corrections: number[]; acknowledgementDeltas: number[] } {
  const inputPackets: Array<{ deliverAtMs: number; packet: ArrayBuffer }> = [];
  const statePackets: Array<{ deliverAtMs: number; packet: ArrayBuffer }> = [];
  const inputHistory: InputCommand[] = [];
  const corrections: number[] = [];
  const acknowledgementDeltas: number[] = [];
  let acknowledgement: StateAcknowledgement | null = null;
  let nextClientAtMs = options.clientPhaseMs;
  let nextServerAtMs = 0;
  let sequence = 0;
  let latestAuthorityTick = -1;
  let lastAcknowledgedSequence: number | null = null;

  for (let nowMs = 0; nowMs <= options.durationMs; nowMs += 1) {
    while (nextClientAtMs <= nowMs) {
      const command = options.command(sequence++, nextClientAtMs);
      options.predictor.pushInput(command);
      inputHistory.push(command);
      if (inputHistory.length > INPUT_REDUNDANCY) inputHistory.shift();
      inputPackets.push({
        deliverAtMs: nextClientAtMs + inputDelayMs(command.sequence),
        packet: encodeInputBundle(inputHistory, acknowledgement),
      });
      nextClientAtMs += FIXED_STEP_MS;
    }
    inputPackets.sort((left, right) => left.deliverAtMs - right.deliverAtMs);
    while (inputPackets[0] && inputPackets[0].deliverAtMs <= nowMs) {
      const decoded = decodeInputPacket(inputPackets.shift()!.packet);
      if (decoded.acknowledgement && options.scheduler)
        options.scheduler.acknowledge(decoded.acknowledgement);
      for (const command of decoded.commands) options.game.acceptInput(options.playerId, command);
    }

    while (nextServerAtMs <= nowMs) {
      options.game.advance(PHYSICS_DT);
      options.onServerTick?.();
      if (options.game.serverTick % SNAPSHOT_INTERVAL_TICKS === 0) {
        const current = options.game.snapshot({ full: false });
        const selected = options.scheduler
          ? options.scheduler.select(
              current,
              options.game.playerPosition(options.playerId),
              options.playerId,
              options.game.grabbedTarget(options.playerId),
            )
          : current;
        const packet = encodeSnapshot(selected);
        options.scheduler?.sent(selected);
        options.onSelectedState?.(selected.serverTick, selected);
        statePackets.push({
          deliverAtMs: nextServerAtMs + stateDelayMs(selected.serverTick),
          packet,
        });
      }
      nextServerAtMs += FIXED_STEP_MS;
    }

    statePackets.sort((left, right) => left.deliverAtMs - right.deliverAtMs);
    while (statePackets[0] && statePackets[0].deliverAtMs <= nowMs) {
      const snapshot = decodeSnapshot(statePackets.shift()!.packet);
      acknowledgement = acknowledgeState(acknowledgement, snapshot.serverTick);
      options.predictor.reconcile(snapshot);
      if (snapshot.serverTick <= latestAuthorityTick) continue;
      latestAuthorityTick = snapshot.serverTick;
      const player = snapshot.players.find(({ id }) => sameId(id, options.playerId))!;
      if (lastAcknowledgedSequence !== null)
        acknowledgementDeltas.push(player.lastProcessedInputSequence - lastAcknowledgedSequence);
      lastAcknowledgedSequence = player.lastProcessedInputSequence;
      if (snapshot.serverTick > 100) corrections.push(options.predictor.lastReconciliationError);
    }
  }
  return { corrections, acknowledgementDeltas };
}

function input(
  worldEpoch: number,
  sequence: number,
  overrides: Partial<InputCommand>,
): InputCommand {
  return {
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch,
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

function inputDelayMs(sequence: number): number {
  return [0, 50, 50, 50, 0, 9][sequence % 6]!;
}

function stateDelayMs(serverTick: number): number {
  return [2, 13, 1, 8][Math.floor(serverTick / SNAPSHOT_INTERVAL_TICKS) % 4]!;
}

function runtimeId(game: AuthoritativeGame, authoredId: string): RuntimeId {
  const bundle = game.worldMessage().bundle;
  const runtime = game
    .worldMessage()
    .runtimeEntities.find(
      (candidate) =>
        candidate.kind === "world-entity" &&
        bundle.entities[candidate.entityIndex]?.authoredId === authoredId,
    );
  if (!runtime) throw new Error(`runtime ${authoredId} is missing`);
  return runtime.id;
}

function bodyState(game: AuthoritativeGame, id: RuntimeId) {
  const body = game.snapshot().bodies.find((candidate) => sameId(candidate.id, id));
  if (!body) throw new Error(`body ${id.index}:${id.generation} is missing`);
  return body;
}

function sameId(left: RuntimeId, right: RuntimeId): boolean {
  return left.index === right.index && left.generation === right.generation;
}

function percentile(values: number[], amount: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))] ?? 0;
}

function maximumGap(ticks: number[]): number {
  let result = 0;
  for (let index = 1; index < ticks.length; index += 1)
    result = Math.max(result, ticks[index]! - ticks[index - 1]!);
  return result;
}
