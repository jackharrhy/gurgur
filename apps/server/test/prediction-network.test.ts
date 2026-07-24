import { describe, expect, test } from "bun:test";
import { PLAYER_CAPSULE_RADIUS, PLAYER_HALF_HEIGHT, compileWorld } from "@gurgur/game";
import {
  PHYSICS_DT,
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL_TICKS,
  type InputCommand,
  type Snapshot,
} from "@gurgur/engine";
import { PlayerPredictor } from "../../web/src/prediction";
import { AuthoritativeGame } from "../src/game";
import { WorldStore } from "../src/store";

const fixturePath = new URL("../../../content/maps/fixtures/network-boxes.map", import.meta.url);
const pushCorridorPath = new URL(
  "../../../content/maps/fixtures/network-push-corridor.map",
  import.meta.url,
);

describe("server-authoritative props with player-only prediction", () => {
  test("replays the player against an authoritative push-prop collision proxy", async () => {
    const bundle = compileWorld(await Bun.file(fixturePath).text(), "network-boxes.map");
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      { worldBundle: bundle },
    );
    const predictor = new PlayerPredictor(() => {});
    try {
      game.advance(PHYSICS_DT * 60);
      const playerId = game.connectPlayer("prediction-fixture");
      const box = game
        .worldMessage()
        .runtimeEntities.find(
          (runtime) =>
            runtime.kind === "world-entity" &&
            bundle.entities[runtime.entityIndex]?.authoredId === "fixture.push",
        )!;
      const boxEntity = bundle.entities.find((entity) => entity.authoredId === "fixture.push")!;
      const boxBrush = bundle.brushes[boxEntity.body!.brushIndices[0]!]!;
      const boxHalfX = Math.max(...boxBrush.localVertices.map((vertex) => Math.abs(vertex.x)));
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(game.worldMessage());
      predictor.reconcile(game.snapshot());
      expect(predictor.predictedBodies.length).toBeGreaterThan(0);

      const delayed: Array<{ deliverAtTick: number; snapshot: Snapshot }> = [];
      let maximumPlayerError = 0;
      let maximumBoxError = 0;
      let maximumVisualPenetration = 0;
      for (let sequence = 0; sequence < 120; sequence += 1) {
        const input = command(sequence, game.worldEpoch);
        game.acceptInput(playerId, input);
        predictor.pushInput(input);
        game.advance(PHYSICS_DT);
        if (game.serverTick % SNAPSHOT_INTERVAL_TICKS === 0) {
          delayed.push({
            deliverAtTick: game.serverTick + 6,
            snapshot: game.snapshot({ full: false }),
          });
        }
        while (delayed[0] && delayed[0].deliverAtTick <= game.serverTick) {
          predictor.reconcile(delayed.shift()!.snapshot);
        }

        if (sequence < 30) continue;
        const authority = game.snapshot();
        const authorityPlayer = authority.players.find((player) => sameId(player.id, playerId))!;
        const authorityBox = authority.bodies.find((body) => sameId(body.id, box.id))!;
        const predictedPlayer = predictor.predictedPosition!;
        const predictedBox = predictor.predictedBody(box.id)!;
        maximumPlayerError = Math.max(
          maximumPlayerError,
          distance(predictedPlayer, authorityPlayer.position),
        );
        maximumBoxError = Math.max(
          maximumBoxError,
          distance(predictedBox.position, authorityBox.position),
        );
        maximumVisualPenetration = Math.max(
          maximumVisualPenetration,
          PLAYER_CAPSULE_RADIUS + boxHalfX - Math.abs(predictedBox.position.x - predictedPlayer.x),
        );
      }

      expect(maximumPlayerError).toBeLessThan(0.01);
      expect(maximumBoxError).toBeLessThan(0.01);
      expect(maximumVisualPenetration).toBeLessThan(0.006);
    } finally {
      predictor.dispose();
      game.stop();
      store.close();
    }
  });

  test("keeps a pushed contact proxy outside the player across bidirectional latency", async () => {
    const bundle = compileWorld(
      await Bun.file(pushCorridorPath).text(),
      "network-push-corridor.map",
    );
    const boxEntity = bundle.entities.find((entity) => entity.authoredId === "corridor.light")!;
    const boxBrush = bundle.brushes[boxEntity.body!.brushIndices[0]!]!;
    const boxHalfX = Math.max(...boxBrush.localVertices.map((vertex) => Math.abs(vertex.x)));
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      {
        worldBundle: bundle,
        playerSpawn: {
          x: boxBrush.center.x - boxHalfX - 1.2,
          y: PLAYER_HALF_HEIGHT,
          z: boxBrush.center.z,
        },
      },
    );
    const predictor = new PlayerPredictor(() => {});
    try {
      game.advance(PHYSICS_DT * 60);
      const playerId = game.connectPlayer("bidirectional-latency-fixture");
      const box = game
        .worldMessage()
        .runtimeEntities.find(
          (runtime) =>
            runtime.kind === "world-entity" &&
            bundle.entities[runtime.entityIndex]?.authoredId === "corridor.light",
        )!;
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(game.worldMessage());
      predictor.reconcile(game.snapshot());

      const delayedInputs: Array<{ deliverAtTick: number; command: InputCommand }> = [];
      const delayedState: Array<{ deliverAtTick: number; snapshot: Snapshot }> = [];
      let maximumVisualPenetration = 0;
      for (let sequence = 0; sequence < 120; sequence += 1) {
        const input = command(sequence, game.worldEpoch);
        predictor.pushInput(input);
        delayedInputs.push({ deliverAtTick: game.serverTick + 5, command: input });
        while (delayedInputs[0] && delayedInputs[0].deliverAtTick <= game.serverTick) {
          game.acceptInput(playerId, delayedInputs.shift()!.command);
        }
        game.advance(PHYSICS_DT);
        if (game.serverTick % SNAPSHOT_INTERVAL_TICKS === 0) {
          delayedState.push({
            deliverAtTick: game.serverTick + 5,
            snapshot: game.snapshot({ full: false }),
          });
        }
        while (delayedState[0] && delayedState[0].deliverAtTick <= game.serverTick) {
          predictor.reconcile(delayedState.shift()!.snapshot);
        }

        const predictedPlayer = predictor.predictedPosition!;
        const predictedBox = predictor.predictedBody(box.id)!;
        maximumVisualPenetration = Math.max(
          maximumVisualPenetration,
          PLAYER_CAPSULE_RADIUS + boxHalfX - Math.abs(predictedBox.position.x - predictedPlayer.x),
        );
      }

      expect(maximumVisualPenetration).toBeLessThan(0.006);
    } finally {
      predictor.dispose();
      game.stop();
      store.close();
    }
  });

  test("keeps authoritative stack support aligned across delayed sparse snapshots", async () => {
    const bundle = compileWorld(await Bun.file(fixturePath).text(), "network-boxes.map");
    const upperEntity = bundle.entities.find(
      (entity) => entity.authoredId === "fixture.stack.upper",
    )!;
    const upperBrush = bundle.brushes[upperEntity.body!.brushIndices[0]!]!;
    const localTop = Math.max(...upperBrush.localVertices.map((vertex) => vertex.y));
    const store = new WorldStore(":memory:");
    const game = await AuthoritativeGame.create(
      store,
      () => {},
      () => {},
      {
        worldBundle: bundle,
        playerSpawn: {
          x: upperBrush.center.x,
          y: upperBrush.center.y + localTop + 2.5,
          z: upperBrush.center.z,
        },
      },
    );
    const predictor = new PlayerPredictor(() => {});
    try {
      game.advance(PHYSICS_DT * 60);
      const playerId = game.connectPlayer("stack-fixture");
      const upper = game
        .worldMessage()
        .runtimeEntities.find(
          (runtime) =>
            runtime.kind === "world-entity" &&
            bundle.entities[runtime.entityIndex]?.authoredId === "fixture.stack.upper",
        )!;
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(game.worldMessage());
      predictor.reconcile(game.snapshot());

      const delayed: Array<{ deliverAtTick: number; snapshot: Snapshot }> = [];
      let maximumPlayerError = 0;
      let maximumUpperBoxError = 0;
      let maximumVerticalPenetration = 0;
      let groundedMismatches = 0;
      let groundedBeforeJump = false;
      let airborneAfterJump = false;
      let landedAfterJump = false;
      for (let sequence = 0; sequence < 180; sequence += 1) {
        const input = command(sequence, game.worldEpoch, {
          moveX: 0,
          jumpCounter: sequence >= 90 ? 1 : 0,
        });
        game.acceptInput(playerId, input);
        predictor.pushInput(input);
        game.advance(PHYSICS_DT);
        if (game.serverTick % SNAPSHOT_INTERVAL_TICKS === 0) {
          delayed.push({
            deliverAtTick: game.serverTick + 6,
            snapshot: game.snapshot({ full: false }),
          });
        }
        while (delayed[0] && delayed[0].deliverAtTick <= game.serverTick) {
          predictor.reconcile(delayed.shift()!.snapshot);
        }

        const authority = game.snapshot();
        const authorityPlayer = authority.players.find((player) => sameId(player.id, playerId))!;
        const authorityUpper = authority.bodies.find((body) => sameId(body.id, upper.id))!;
        const predictedPlayer = predictor.predictedPosition!;
        const predictedUpper = predictor.predictedBody(upper.id)!;
        if (sequence >= 30) {
          maximumPlayerError = Math.max(
            maximumPlayerError,
            distance(predictedPlayer, authorityPlayer.position),
          );
          maximumUpperBoxError = Math.max(
            maximumUpperBoxError,
            distance(predictedUpper.position, authorityUpper.position),
          );
          maximumVerticalPenetration = Math.max(
            maximumVerticalPenetration,
            predictedUpper.position.y + localTop + 0.88 - predictedPlayer.y,
          );
          if (predictor.predictedGrounded !== authorityPlayer.grounded) groundedMismatches += 1;
        }
        if (sequence === 80) groundedBeforeJump = authorityPlayer.grounded;
        if (sequence > 90 && sequence < 130 && !authorityPlayer.grounded) airborneAfterJump = true;
        if (sequence > 140 && authorityPlayer.grounded) landedAfterJump = true;
      }

      expect(groundedBeforeJump).toBe(true);
      expect(airborneAfterJump).toBe(true);
      expect(landedAfterJump).toBe(true);
      expect(maximumPlayerError).toBeLessThan(0.06);
      expect(maximumUpperBoxError).toBeLessThan(0.03);
      expect(maximumVerticalPenetration).toBeLessThan(0.04);
      expect(groundedMismatches).toBeLessThan(8);
    } finally {
      predictor.dispose();
      game.stop();
      store.close();
    }
  });
});

function command(
  sequence: number,
  worldEpoch: number,
  options: { moveX?: number; jumpCounter?: number } = {},
): InputCommand {
  return {
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch,
    sequence,
    clientTick: sequence,
    moveX: options.moveX ?? 1,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    jumpCounter: options.jumpCounter ?? 0,
    interactCounter: 0,
    interactTarget: null,
    primaryCounter: 0,
  };
}

function sameId(
  a: { index: number; generation: number },
  b: { index: number; generation: number },
): boolean {
  return a.index === b.index && a.generation === b.generation;
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
