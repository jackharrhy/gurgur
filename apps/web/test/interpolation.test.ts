import { describe, expect, test } from "bun:test";
import { createSnapshotTimeline } from "../src/interpolation";

function snapshot(tick: number, y: number, epoch = 1, velocityY = 0, flags = 0) {
  return {
    worldEpoch: epoch,
    serverTick: tick,
    bodies: [{
      id: { index: 1, generation: 1 },
      position: { x: 0, y, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linearVelocity: { x: 0, y: velocityY, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      flags,
    }],
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
