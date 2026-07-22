import worldBundleJson from "../../../content/generated/systems-garden.json";
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type BodySnapshot, type InputCommand, type Snapshot, type WorldBundle } from "@gurgur/shared";
import { PlayerPredictor } from "../src/prediction";

const bundle = worldBundleJson as unknown as WorldBundle;
const playerId = { index: 0x8000_0000, generation: 1 };
const spawn = bundle.entities.find((entity) => entity.classname === "info_player_start")!.origin!;

describe("PlayerPredictor", () => {
  test("replays unacknowledged input without changing the presented path", async () => {
    let presentation: BodySnapshot | null = null;
    const predictor = new PlayerPredictor((body) => { presentation = body; });
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld({ type: "world", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, bundle, runtimeEntities: [] });
      predictor.reconcile(snapshot(-1, { x: spawn.x, y: spawn.y + 0.9, z: spawn.z }));

      for (let sequence = 0; sequence < 3; sequence += 1) predictor.pushInput(command(sequence));
      const processedThroughTwo = predictor.predictedPosition!;
      for (let sequence = 3; sequence < 6; sequence += 1) predictor.pushInput(command(sequence));
      const beforeReconcile = predictor.predictedPosition!;

      predictor.reconcile(snapshot(2, processedThroughTwo));
      expect(predictor.pendingInputCount).toBe(3);
      expect(predictor.predictedPosition!.x).toBeCloseTo(beforeReconcile.x, 4);
      expect(predictor.predictedPosition!.z).toBeCloseTo(beforeReconcile.z, 4);
      expect(predictor.correctionMagnitude).toBeLessThan(0.01);
      expect(presentation).not.toBeNull();
    } finally {
      predictor.dispose();
    }
  });

  test("snaps a divergent prediction at the correction threshold", async () => {
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld({ type: "world", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, bundle, runtimeEntities: [] });
      predictor.reconcile(snapshot(-1, { x: spawn.x, y: spawn.y + 0.9, z: spawn.z }));
      predictor.pushInput(command(0));
      const teleported = { x: spawn.x + 5, y: spawn.y + 0.9, z: spawn.z };
      predictor.reconcile(snapshot(0, teleported));
      expect(predictor.pendingInputCount).toBe(0);
      expect(predictor.predictedPosition!.x).toBeCloseTo(teleported.x);
      expect(predictor.correctionMagnitude).toBe(0);
    } finally {
      predictor.dispose();
    }
  });

  test("decays a small render-only correction within 100 milliseconds", async () => {
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld({ type: "world", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, bundle, runtimeEntities: [] });
      predictor.reconcile(snapshot(-1, { x: spawn.x, y: spawn.y + 0.9, z: spawn.z }));
      predictor.pushInput(command(0));
      const predicted = predictor.predictedPosition!;
      predictor.reconcile(snapshot(0, { ...predicted, x: predicted.x + 0.1 }));
      expect(predictor.correctionMagnitude).toBeWithin(0.09, 0.11);
      for (let sequence = 1; sequence <= 6; sequence += 1) predictor.pushInput(command(sequence, 0));
      expect(predictor.correctionMagnitude).toBeLessThan(0.0001);
    } finally {
      predictor.dispose();
    }
  });

  test("lands on the real Systems Garden heavy dynamic cube instead of phasing through it", async () => {
    const entity = bundle.entities.find((candidate) => candidate.authoredId === "physics.cube.heavy")!;
    const brushIndex = entity.brushIndices[0]!;
    const brush = bundle.brushes[brushIndex]!;
    const cubeId = { index: 42, generation: 1 };
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld({
        type: "world",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        bundle,
        runtimeEntities: [{
          id: cubeId,
          authoredId: entity.authoredId!,
          classname: "func_physics",
          brushIndex,
        }],
      });
      const start = {
        x: brush.center.x,
        y: brush.center.y + Math.max(...brush.localVertices.map((vertex) => vertex.y)) + 2.5,
        z: brush.center.z,
      };
      predictor.reconcile({
        worldEpoch: 1,
        serverTick: 0,
        bodies: [{
          id: cubeId,
          position: brush.center,
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          linearVelocity: { x: 0, y: 0, z: 0 },
          angularVelocity: { x: 0, y: 0, z: 0 },
        }],
        players: [{
          id: playerId,
          position: start,
          yaw: 0,
          verticalVelocity: 0,
          grounded: false,
          lastProcessedInputSequence: -1,
          lastJumpCounter: 0,
          stepCooldown: 0,
          crouched: false,
        }],
      });
      for (let sequence = 0; sequence < 120; sequence += 1) predictor.pushInput(command(sequence, 0));
      const predictedCube = predictor.predictedBody(cubeId)!;
      expect(predictor.predictedPosition!.y).toBeCloseTo(
        predictedCube.position.y + Math.max(...brush.localVertices.map((vertex) => vertex.y)) + 0.9,
        1,
      );
    } finally {
      predictor.dispose();
    }
  });
});

function command(sequence: number, moveX = 1): InputCommand {
  return {
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: 1,
    sequence,
    clientTick: sequence,
    moveX,
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

function snapshot(lastProcessedInputSequence: number, position: { x: number; y: number; z: number }): Snapshot {
  return {
    worldEpoch: 1,
    serverTick: Math.max(0, lastProcessedInputSequence + 1),
    bodies: [],
    players: [{
      id: playerId,
      position,
      yaw: 0,
      verticalVelocity: 0,
      grounded: true,
      lastProcessedInputSequence,
      lastJumpCounter: 0,
      stepCooldown: 0,
      crouched: false,
    }],
  };
}
