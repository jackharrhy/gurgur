import { expect, test } from "bun:test";
import {
  STATE_DATAGRAM_TARGET_BYTES,
  SNAPSHOT_FLAG_TELEPORT,
  decodeSnapshot,
  encodeSnapshot,
  type BodySnapshot,
  type PlayerStateSnapshot,
} from "@gurgur/shared";
import { snapshotForPlayer } from "../src/server";

test("player interest keeps local and near records while rotating distant records", () => {
  const players = Array.from({ length: 32 }, (_, index) => player(index));
  const bodies = [
    ...players.map((entry) => body(entry.id, entry.position)),
    ...Array.from({ length: 64 }, (_, index) =>
      body({ index: index + 1, generation: 1 }, { x: index * 0.75, y: 0.5, z: 2 }),
    ),
  ];
  bodies[0]!.flags = SNAPSHOT_FLAG_TELEPORT;
  const local = players[0]!;
  const selected = Array.from({ length: 19 }, (_, rotation) =>
    snapshotForPlayer(
      { worldEpoch: 1, serverTick: rotation * 2, players, bodies },
      local.position,
      local.id,
    ),
  );

  for (const snapshot of selected) {
    expect(snapshot.players).toHaveLength(16);
    expect(snapshot.players.map(({ id }) => key(id))).toContain(key(local.id));
    expect(
      snapshot.players.every((playerState) =>
        snapshot.bodies.some(({ id }) => key(id) === key(playerState.id)),
      ),
    ).toBe(true);
    expect(encodeSnapshot(snapshot).byteLength).toBeLessThanOrEqual(STATE_DATAGRAM_TARGET_BYTES);
  }

  const alwaysPresent = players.slice(0, 13).map(({ id }) => key(id));
  for (const identity of alwaysPresent)
    expect(
      selected.every((snapshot) => snapshot.players.some(({ id }) => key(id) === identity)),
    ).toBe(true);

  const distantSeen = new Set(
    selected.flatMap((snapshot) => snapshot.players.slice(13).map(({ id }) => key(id))),
  );
  expect(distantSeen).toEqual(new Set(players.slice(13).map(({ id }) => key(id))));
  expect(
    decodeSnapshot(encodeSnapshot(selected[0]!)).bodies.find(({ id }) => key(id) === key(local.id))!
      .flags,
  ).toBe(SNAPSHOT_FLAG_TELEPORT);
});

function player(index: number): PlayerStateSnapshot {
  return {
    id: { index: 0x8000_0000 + index, generation: 1 },
    position: { x: index, y: 0.9, z: 0 },
    yaw: 0,
    verticalVelocity: 0,
    grounded: true,
    lastProcessedInputSequence: 0,
    lastJumpCounter: 0,
    stepCooldown: 0,
    crouched: false,
  };
}

function body(
  id: { index: number; generation: number },
  position: { x: number; y: number; z: number },
): BodySnapshot {
  return {
    id,
    position,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
}

function key(id: { index: number; generation: number }): string {
  return `${id.index}:${id.generation}`;
}
