import { expect, test } from "bun:test";
import { SNAPSHOT_HISTORY_PACKETS, type Snapshot } from "@gurgur/shared";
import { retainSnapshot } from "../src/session";

test("retains a bounded pre-world snapshot history instead of overwriting the initial full state", () => {
  const queue: Snapshot[] = [];
  const state = (tick: number, bodyIndex: number): Snapshot => ({
    worldEpoch: 1,
    serverTick: tick,
    bodies: [
      {
        id: { index: bodyIndex, generation: 1 },
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ],
    players: [],
  });

  retainSnapshot(queue, state(1, 1));
  retainSnapshot(queue, state(2, 2));
  expect(queue.map((snapshot) => snapshot.bodies[0]!.id.index)).toEqual([1, 2]);

  for (let tick = 3; tick <= SNAPSHOT_HISTORY_PACKETS + 2; tick += 1) {
    retainSnapshot(queue, state(tick, tick));
  }
  expect(queue).toHaveLength(SNAPSHOT_HISTORY_PACKETS);
  expect(queue[0]?.serverTick).toBe(3);
});

test("sorts reordered disposable snapshots and replaces duplicate ticks", () => {
  const queue: Snapshot[] = [];
  const state = (tick: number, x = tick): Snapshot => ({
    worldEpoch: 1,
    serverTick: tick,
    bodies: [
      {
        id: { index: 1, generation: 1 },
        position: { x, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    ],
    players: [],
  });
  retainSnapshot(queue, state(12));
  retainSnapshot(queue, state(10));
  retainSnapshot(queue, state(11));
  retainSnapshot(queue, state(11, 99));
  expect(queue.map(({ serverTick }) => serverTick)).toEqual([10, 11, 12]);
  expect(queue[1]!.bodies[0]!.position.x).toBe(99);
});
