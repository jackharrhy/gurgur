import { describe, expect, test } from "bun:test";
import {
  PHYSICS_DT,
  PROTOCOL_VERSION,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_TELEPORT,
  type BodySnapshot,
  type InputCommand,
  type RuntimeEntity,
  type Snapshot,
  type Vec3,
  type WorldBundle,
} from "@gurgur/shared";
import { compileWorld } from "@gurgur/world-compiler";
import { PlayerPredictor } from "../src/prediction";

const playerId = { index: 0x8000_0000, generation: 1 };

describe("player-only prediction", () => {
  test("replays unacknowledged intent without changing the presented path", async () => {
    const bundle = await fixture("network-push-corridor");
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(world(bundle));
      const start = spawn(bundle);
      predictor.reconcile(snapshot(-1, start));
      for (let sequence = 0; sequence < 3; sequence += 1) predictor.pushInput(command(sequence));
      const throughTwo = predictor.predictedPosition!;
      for (let sequence = 3; sequence < 6; sequence += 1) predictor.pushInput(command(sequence));
      const before = predictor.predictedPosition!;

      predictor.reconcile(snapshot(2, throughTwo, 3));
      expect(predictor.pendingInputCount).toBe(3);
      expect(predictor.predictedPosition!.x).toBeCloseTo(before.x, 4);
      expect(predictor.predictedPosition!.z).toBeCloseTo(before.z, 4);
      expect(predictor.correctionMagnitude).toBeLessThan(0.01);
    } finally {
      predictor.dispose();
    }
  });

  test("snaps a large divergence and smooths a small render-only correction", async () => {
    const bundle = await fixture("network-push-corridor");
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(world(bundle));
      const start = spawn(bundle);
      predictor.reconcile(snapshot(-1, start));
      predictor.pushInput(command(0));
      predictor.reconcile(snapshot(0, { ...start, z: start.z + 5 }, 1));
      expect(predictor.predictedPosition!.z).toBeCloseTo(start.z + 5);
      expect(predictor.correctionMagnitude).toBe(0);

      predictor.pushInput(command(1));
      const predicted = predictor.predictedPosition!;
      predictor.reconcile(snapshot(1, { ...predicted, x: predicted.x + 0.1 }, 2));
      expect(predictor.correctionMagnitude).toBeWithin(0.09, 0.11);
      for (let sequence = 2; sequence <= 7; sequence += 1)
        predictor.pushInput(command(sequence, { moveX: 0 }));
      expect(predictor.correctionMagnitude).toBeLessThan(0.0001);
    } finally {
      predictor.dispose();
    }
  });

  test("treats a state stall as a prediction discontinuity", async () => {
    const bundle = await fixture("network-push-corridor");
    const runtime = runtimes(bundle);
    const light = runtime.find((entity) => entity.authoredId === "corridor.light")!;
    if (!("brushIndex" in light)) throw new Error("light fixture is not physical");
    const brush = bundle.brushes[light.brushIndex]!;
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(world(bundle, runtime));
      const authority = spawn(bundle);
      const movingBody: BodySnapshot = {
        id: light.id,
        position: brush.center,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        linearVelocity: { x: 1, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      };
      predictor.reconcile(snapshot(-1, authority, 0, [movingBody]));
      for (let sequence = 0; sequence < 20; sequence += 1) predictor.pushInput(command(sequence));
      expect(predictor.pendingInputCount).toBe(20);

      predictor.reconcile(snapshot(-1, authority, 60, [movingBody]));
      expect(predictor.pendingInputCount).toBe(0);
      expect(predictor.predictedPosition).toEqual(authority);
      expect(predictor.predictedBody(light.id)!.linearVelocity).toEqual(movingBody.linearVelocity!);
      expect(predictor.predictedBodies).toContainEqual(predictor.predictedBody(light.id)!);
    } finally {
      predictor.dispose();
    }
  });

  test("clears replay and correction across an authoritative teleport", async () => {
    const bundle = await fixture("network-push-corridor");
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(world(bundle));
      const start = spawn(bundle);
      predictor.reconcile(snapshot(-1, start));
      for (let sequence = 0; sequence < 10; sequence += 1) predictor.pushInput(command(sequence));

      const destination = { ...start, z: start.z + 12 };
      predictor.reconcile(
        snapshot(-1, destination, 12, [
          {
            id: playerId,
            position: destination,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            linearVelocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            flags: SNAPSHOT_FLAG_TELEPORT,
          },
        ]),
      );
      expect(predictor.pendingInputCount).toBe(0);
      expect(predictor.predictedPosition).toEqual(destination);
      expect(predictor.lastReconciliationError).toBe(0);
      expect(predictor.correctionMagnitude).toBe(0);

      predictor.pushInput(command(10, { moveX: 0 }));
      predictor.pushInput(command(11, { moveX: 0 }));
      const repeatedDestination = { ...destination, x: destination.x + 0.01 };
      predictor.reconcile(
        snapshot(-1, repeatedDestination, 14, [
          {
            id: playerId,
            position: repeatedDestination,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            linearVelocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            flags: SNAPSHOT_FLAG_TELEPORT,
          },
        ]),
      );
      expect(predictor.pendingInputCount).toBe(2);
      const afterRepeatedMarker = predictor.predictedPosition;
      predictor.reconcile(snapshot(-1, { ...destination, z: destination.z - 100 }, 13));
      expect(predictor.predictedPosition).toEqual(afterRepeatedMarker);
    } finally {
      predictor.dispose();
    }
  });

  test("uses authoritative dynamics as moving kinematic collision proxies", async () => {
    const bundle = await fixture("network-push-corridor");
    const runtime = runtimes(bundle);
    const light = runtime.find((entity) => entity.authoredId === "corridor.light")!;
    if (!("brushIndex" in light)) throw new Error("light fixture is not physical");
    const brush = bundle.brushes[light.brushIndex]!;
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(world(bundle, runtime));
      predictor.reconcile(
        snapshot(-1, spawn(bundle), 0, [
          {
            id: light.id,
            position: brush.center,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            linearVelocity: { x: 1, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
          },
        ]),
      );
      for (let sequence = 0; sequence < 6; sequence += 1)
        predictor.pushInput(command(sequence, { moveX: 0 }));
      expect(predictor.predictedBody(light.id)!.position.x).toBeCloseTo(
        brush.center.x + 6 * PHYSICS_DT,
        2,
      );
      expect(predictor.predictedBodies).toContainEqual(predictor.predictedBody(light.id)!);

      for (let sequence = 6; sequence < 18; sequence += 1)
        predictor.pushInput(command(sequence, { moveX: 0 }));
      expect(predictor.predictedBody(light.id)!.position.x).toBeCloseTo(
        brush.center.x + 6 * PHYSICS_DT,
        2,
      );
      expect(predictor.predictedBody(light.id)!.linearVelocity?.x).toBe(0);

      const authority = predictor.predictedBody(light.id)!;
      predictor.reconcile(
        snapshot(17, predictor.predictedPosition!, 18, [
          {
            ...authority,
            linearVelocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            flags: SNAPSHOT_FLAG_SLEEP,
          },
        ]),
      );
      for (let sequence = 18; sequence < 90; sequence += 1)
        predictor.pushInput(command(sequence, { moveX: 1 }));
      const afterPlayerContact = predictor.predictedBody(light.id)!;
      expect(afterPlayerContact.position.x).toBeCloseTo(authority.position.x, 2);
    } finally {
      predictor.dispose();
    }
  });

  test("retains sparse body authority from every snapshot in a render batch", async () => {
    const bundle = await fixture("network-push-corridor");
    const runtime = runtimes(bundle);
    const light = runtime.find((entity) => entity.authoredId === "corridor.light")!;
    if (!("brushIndex" in light)) throw new Error("light fixture is not physical");
    const brush = bundle.brushes[light.brushIndex]!;
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(world(bundle, runtime));
      predictor.reconcile(
        snapshot(-1, spawn(bundle), 2, [
          {
            id: light.id,
            position: brush.center,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            linearVelocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            flags: SNAPSHOT_FLAG_SLEEP,
          },
        ]),
        false,
      );
      predictor.reconcile(snapshot(-1, spawn(bundle), 4));
      for (let sequence = 0; sequence < 12; sequence += 1) {
        predictor.pushInput(command(sequence, { moveX: 0 }));
      }
      expect(predictor.predictedBodies).toContainEqual(predictor.predictedBody(light.id)!);

      predictor.reconcile(
        snapshot(-1, spawn(bundle), 1, [
          {
            id: light.id,
            position: { ...brush.center, x: brush.center.x - 5 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
        ]),
        false,
      );
      expect(predictor.predictedBody(light.id)!.position.x).toBeCloseTo(brush.center.x, 5);
    } finally {
      predictor.dispose();
    }
  });

  test("lands on an authoritative dynamic proxy without locally simulating the prop", async () => {
    const bundle = await fixture("network-boxes");
    const runtime = runtimes(bundle);
    const lower = runtime.find((entity) => entity.authoredId === "fixture.stack.lower")!;
    if (!("brushIndex" in lower)) throw new Error("stack fixture is not physical");
    const brush = bundle.brushes[lower.brushIndex]!;
    const predictor = new PlayerPredictor(() => {});
    try {
      predictor.setLocalPlayer(playerId);
      await predictor.setWorld(world(bundle, [lower]));
      const top = Math.max(...brush.localVertices.map((vertex) => vertex.y));
      const falling = snapshot(
        -1,
        { x: brush.center.x, y: brush.center.y + top + 2.5, z: brush.center.z },
        0,
        [
          {
            id: lower.id,
            position: brush.center,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            linearVelocity: { x: 0, y: 0, z: 0 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            flags: SNAPSHOT_FLAG_SLEEP,
          },
        ],
      );
      falling.players[0]!.grounded = false;
      predictor.reconcile(falling);
      for (let sequence = 0; sequence < 120; sequence += 1)
        predictor.pushInput(command(sequence, { moveX: 0 }));
      expect(predictor.predictedPosition!.y).toBeCloseTo(brush.center.y + top + 0.9, 1);
      expect(predictor.predictedBody(lower.id)!.position.x).toBeCloseTo(brush.center.x, 5);
      expect(predictor.predictedBody(lower.id)!.position.y).toBeCloseTo(brush.center.y, 5);
      expect(predictor.predictedBody(lower.id)!.position.z).toBeCloseTo(brush.center.z, 5);
    } finally {
      predictor.dispose();
    }
  });
});

function world(bundle: WorldBundle, runtimeEntities: RuntimeEntity[] = []) {
  return {
    type: "world" as const,
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: 1,
    bundle,
    runtimeEntities,
  };
}

function runtimes(bundle: WorldBundle): RuntimeEntity[] {
  let index = 1;
  return bundle.entities.flatMap((entity) => {
    if (entity.classname !== "func_physics") return [];
    return [
      {
        id: { index: index++, generation: 1 },
        authoredId: entity.authoredId!,
        classname: "func_physics" as const,
        brushIndex: entity.brushIndices[0]!,
        ...(entity.brushIndices.length > 1 ? { brushIndices: entity.brushIndices } : {}),
      },
    ];
  });
}

function command(sequence: number, overrides: Partial<InputCommand> = {}): InputCommand {
  return {
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: 1,
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
    ...overrides,
  };
}

function snapshot(
  lastProcessedInputSequence: number,
  position: Vec3,
  serverTick = Math.max(0, lastProcessedInputSequence + 1),
  bodies: BodySnapshot[] = [],
): Snapshot {
  return {
    worldEpoch: 1,
    serverTick,
    bodies,
    players: [
      {
        id: playerId,
        position,
        yaw: 0,
        verticalVelocity: 0,
        grounded: true,
        lastProcessedInputSequence,
        lastJumpCounter: 0,
        stepCooldown: 0,
        crouched: false,
      },
    ],
  };
}

function spawn(bundle: WorldBundle): Vec3 {
  const point = bundle.entities.find((entity) => entity.classname === "info_player_start")!.origin!;
  return { x: point.x, y: point.y + 0.9, z: point.z };
}

async function fixture(name: string): Promise<WorldBundle> {
  const path = `content/maps/fixtures/${name}.map`;
  return compileWorld(await Bun.file(path).text(), path);
}
