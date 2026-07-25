import { describe, expect, test } from "bun:test";
import {
  SNAPSHOT_FLAG_GRABBED,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_INTERVAL_TICKS,
  acknowledgeState,
  type BodySnapshot,
  type PlayerStateSnapshot,
  type Snapshot,
} from "@gurgur/engine";
import { ClientSnapshotScheduler } from "../src/snapshot-scheduler";

const localPlayer = player();
const localPosition = localPlayer.position;

describe("per-client current-state scheduling", () => {
  test("caps terminal sleep commits and silences each revision after receipt", () => {
    const scheduler = new ClientSnapshotScheduler();
    const sleeping = Array.from({ length: 40 }, (_, index) =>
      body(index + 1, index * 0.1, SNAPSHOT_FLAG_SLEEP),
    );
    const seen = new Set<string>();

    for (let packet = 0; packet < 12; packet += 1) {
      const tick = packet * SNAPSHOT_INTERVAL_TICKS;
      const selected = scheduler.select(snapshot(tick, sleeping), localPosition, localPlayer.id);
      const selectedProps = propBodies(selected);
      expect(selectedProps.length).toBeLessThanOrEqual(4);
      for (const selectedBody of selectedProps) seen.add(key(selectedBody.id));
      scheduler.sent(selected);
      scheduler.acknowledge(acknowledgeState(null, tick));
    }

    expect(seen.size).toBe(sleeping.length);
    const quiet = scheduler.select(snapshot(24, sleeping), localPosition, localPlayer.id);
    expect(propBodies(quiet)).toHaveLength(0);
  });

  test("keeps held and recently released state in the fast lane through sleep churn", () => {
    const scheduler = new ClientSnapshotScheduler();
    const targetId = { index: 500, generation: 1 };
    const sleeping = Array.from({ length: 40 }, (_, index) =>
      body(index + 1, index * 0.1, SNAPSHOT_FLAG_SLEEP),
    );
    const releaseTick = 10;

    for (let tick = 0; tick <= 44; tick += SNAPSHOT_INTERVAL_TICKS) {
      const grabbed = tick < releaseTick;
      const target = {
        ...body(targetId.index, 1 + tick * 0.02, grabbed ? SNAPSHOT_FLAG_GRABBED : 0),
        id: targetId,
        linearVelocity: { x: 2, y: 0, z: 0 },
      };
      const selected = scheduler.select(
        snapshot(tick, [...sleeping, target]),
        localPosition,
        localPlayer.id,
        grabbed ? targetId : null,
      );
      const containsTarget = propBodies(selected).some(({ id }) => key(id) === key(targetId));
      if (tick <= releaseTick + 30) expect(containsTarget).toBe(true);
      scheduler.sent(selected);
      scheduler.acknowledge(acknowledgeState(null, tick));
    }
  });

  test("bounds nearby awake state age while accumulated priority rotates a saturated set", () => {
    const scheduler = new ClientSnapshotScheduler();
    const awake = Array.from({ length: 40 }, (_, index) => body(index + 1, index * 0.1, 0));
    const lastSeen = new Map<string, number>();
    let maximumGap = 0;

    for (let tick = 0; tick <= 20; tick += SNAPSHOT_INTERVAL_TICKS) {
      const selected = scheduler.select(snapshot(tick, awake), localPosition, localPlayer.id);
      expect(propBodies(selected).length).toBeGreaterThan(0);
      for (const selectedBody of propBodies(selected)) {
        const identity = key(selectedBody.id);
        const previous = lastSeen.get(identity);
        if (previous !== undefined) maximumGap = Math.max(maximumGap, tick - previous);
        lastSeen.set(identity, tick);
      }
      scheduler.sent(selected);
      scheduler.acknowledge(acknowledgeState(null, tick));
    }

    expect(lastSeen.size).toBe(awake.length);
    expect(maximumGap).toBeLessThanOrEqual(SNAPSHOT_INTERVAL_TICKS * 2);
  });
});

function snapshot(serverTick: number, bodies: BodySnapshot[]): Snapshot {
  return {
    worldEpoch: 1,
    serverTick,
    players: [localPlayer],
    bodies,
  };
}

function player(): PlayerStateSnapshot {
  return {
    id: { index: 0x8000_0000, generation: 1 },
    position: { x: 0, y: 0.9, z: 0 },
    yaw: 0,
    verticalVelocity: 0,
    grounded: true,
    lastProcessedInputSequence: 0,
    lastJumpCounter: 0,
    stepCooldown: 0,
    crouched: false,
  };
}

function body(index: number, x: number, flags: number): BodySnapshot {
  return {
    id: { index, generation: 1 },
    position: { x, y: 0.5, z: 2 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    flags,
  };
}

function propBodies(state: Snapshot): BodySnapshot[] {
  return state.bodies.filter(({ id }) => id.index < 0x8000_0000);
}

function key(id: { index: number; generation: number }): string {
  return `${id.index}:${id.generation}`;
}
