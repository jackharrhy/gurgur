import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@gurgur/shared";
import { createSnapshotTimeline } from "../src/interpolation";

function snapshot(tick: number, y: number, epoch = 1, velocityY = 0, flags = 0): Snapshot {
  return {
    worldEpoch: epoch,
    serverTick: tick,
    bodies: [
      {
        id: { index: 1, generation: 1 },
        position: { x: 0, y, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        linearVelocity: { x: 0, y: velocityY, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        flags,
      },
    ],
    players: [],
  };
}

describe("snapshot timeline", () => {
  test("interpolates between authoritative snapshots", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(10, 10));
    history.push(snapshot(20, 0));
    expect(history.sample(15)[0]?.position.y).toBe(5);
  });

  test("interpolates each body across staggered sparse snapshot packets", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(10, 0));
    history.push({ ...snapshot(13, 30), bodies: [] });
    history.push(snapshot(16, 6));

    expect(history.sample(13)[0]?.position.y).toBe(3);
  });

  test("reports per-body extrapolation when a later sparse packet contains only another body", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(10, 0, 1, 2));
    history.push({
      ...snapshot(13, 30),
      bodies: [{ ...snapshot(13, 30).bodies[0]!, id: { index: 2, generation: 1 } }],
    });

    const sample = history.sampleWithMetadata(12);
    expect(sample.bodies.find((body) => body.id.index === 1)?.position.y).toBeCloseTo(2 / 30);
    expect(sample.extrapolatedBodyIds).toEqual([{ index: 1, generation: 1 }]);
  });

  test("does not present a sparse track before its first authoritative sample", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(10, 0));
    history.push({
      ...snapshot(13, 30),
      bodies: [{ ...snapshot(13, 30).bodies[0]!, id: { index: 2, generation: 1 } }],
    });

    const sample = history.sampleWithMetadata(9);
    expect(sample.bodies.map((body) => body.id.index)).toEqual([1]);
    expect(sample.extrapolatedBodyIds).toEqual([]);
  });

  test("holds a final sleep sample without counting it as extrapolation", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(10, 0, 1, 2, 8));

    const sample = history.sampleWithMetadata(12);
    expect(sample.extrapolatedBodyIds).toEqual([]);
  });

  test("derives horizontal velocity for an extrapolated remote player track", () => {
    const history = createSnapshotTimeline();
    const playerSnapshot = (tick: number, x: number) => {
      const state = snapshot(tick, 0);
      state.bodies[0] = {
        ...state.bodies[0]!,
        position: { x, y: 0, z: 0 },
        linearVelocity: { x: 0, y: 0, z: 0 },
      };
      state.players = [
        {
          id: { index: 1, generation: 1 },
          position: { x, y: 0, z: 0 },
          yaw: 0,
          verticalVelocity: 0,
          grounded: true,
          lastProcessedInputSequence: tick,
          lastJumpCounter: 0,
          stepCooldown: 0,
          crouched: false,
        },
      ];
      return state;
    };
    history.push(playerSnapshot(10, 0));
    history.push(playerSnapshot(13, 0.25));

    const sample = history.sampleWithMetadata(14);
    expect(sample.bodies[0]?.position.x).toBeCloseTo(1 / 3);
    expect(sample.extrapolatedBodyIds).toEqual([{ index: 1, generation: 1 }]);
  });

  test("clears old history when world epoch changes", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(10, 10));
    history.push(snapshot(1, 6, 2));
    expect(history.latestTick).toBe(1);
    expect(history.sample(1)[0]?.position.y).toBe(6);
  });

  test("estimates authoritative tick from arrival time and RTT", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(60, 0), 1_000, 50);
    expect(history.serverTickAt(1_000)).toBe(63);
    expect(history.serverTickAt(1_100)).toBe(69);
  });

  test("caps velocity extrapolation at fifty milliseconds", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(60, 1, 1, 2), 1_000);
    expect(history.sample(61)[0]?.position.y).toBeCloseTo(1 + 2 / 60);
    expect(history.sample(600)[0]?.position.y).toBeCloseTo(1.1);
  });

  test("does not interpolate across an explicit teleport discontinuity", () => {
    const history = createSnapshotTimeline();
    history.push(snapshot(10, 0));
    history.push(snapshot(20, 20, 1, 0, 2));
    expect(history.sample(19)[0]?.position.y).toBe(0);
    expect(history.sample(20)[0]?.position.y).toBe(20);
  });
});
