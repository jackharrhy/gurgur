import {
  PHYSICS_HZ,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_HISTORY_PACKETS,
  type BodySnapshot,
  type Quat,
  type Snapshot,
  type Vec3,
} from "@gurgur/shared";

const MAX_EXTRAPOLATION_TICKS = PHYSICS_HZ * 0.05;

function key(body: BodySnapshot): string {
  return `${body.id.index}:${body.id.generation}`;
}

function interpolate(a: BodySnapshot, b: BodySnapshot, amount: number): BodySnapshot {
  let bx = b.rotation.x;
  let by = b.rotation.y;
  let bz = b.rotation.z;
  let bw = b.rotation.w;
  const dot = a.rotation.x * bx + a.rotation.y * by + a.rotation.z * bz + a.rotation.w * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  const qx = a.rotation.x + (bx - a.rotation.x) * amount;
  const qy = a.rotation.y + (by - a.rotation.y) * amount;
  const qz = a.rotation.z + (bz - a.rotation.z) * amount;
  const qw = a.rotation.w + (bw - a.rotation.w) * amount;
  const length = Math.hypot(qx, qy, qz, qw) || 1;
  return {
    id: a.id,
    position: {
      x: a.position.x + (b.position.x - a.position.x) * amount,
      y: a.position.y + (b.position.y - a.position.y) * amount,
      z: a.position.z + (b.position.z - a.position.z) * amount,
    },
    rotation: { x: qx / length, y: qy / length, z: qz / length, w: qw / length },
  };
}

export type SnapshotTimeline = {
  readonly latestTick: number | null;
  push(snapshot: Snapshot, receivedAtMs?: number, oneWayDelayMs?: number): void;
  observeServerTick(serverTick: number, receivedAtMs: number, oneWayDelayMs: number): void;
  serverTickAt(nowMs: number): number;
  sample(targetTick: number): BodySnapshot[];
  sampleWithMetadata(targetTick: number): TimelineSample;
};

export type TimelineSample = {
  bodies: BodySnapshot[];
  extrapolatedBodyIds: BodySnapshot["id"][];
};

export function createSnapshotTimeline(): SnapshotTimeline {
  let worldEpoch: number | null = null;
  let snapshots: Snapshot[] = [];
  let clockTick: number | null = null;
  let clockAtMs = 0;

  const latestTick = (): number | null => snapshots.at(-1)?.serverTick ?? null;

  const serverTickAt = (nowMs: number): number => {
    if (clockTick === null) return latestTick() ?? 0;
    return clockTick + (Math.max(0, nowMs - clockAtMs) * PHYSICS_HZ) / 1_000;
  };

  const observeServerTick = (
    serverTick: number,
    receivedAtMs: number,
    oneWayDelayMs: number,
  ): void => {
    const candidate = serverTick + (oneWayDelayMs * PHYSICS_HZ) / 1_000;
    const current = serverTickAt(receivedAtMs);
    if (clockTick === null || candidate >= current - 1) {
      clockTick = candidate;
      clockAtMs = receivedAtMs;
    }
  };

  const push = (snapshot: Snapshot, receivedAtMs = performance.now(), oneWayDelayMs = 0): void => {
    if (snapshot.worldEpoch !== worldEpoch) {
      worldEpoch = snapshot.worldEpoch;
      snapshots = [];
      clockTick = null;
    }
    const latest = snapshots.at(-1);
    if (latest && snapshot.serverTick <= latest.serverTick) return;
    snapshots.push(snapshot);
    if (snapshots.length > SNAPSHOT_HISTORY_PACKETS) snapshots.shift();
    observeServerTick(snapshot.serverTick, receivedAtMs, oneWayDelayMs);
  };

  const sampleWithMetadata = (targetTick: number): TimelineSample => {
    if (snapshots.length === 0) return { bodies: [], extrapolatedBodyIds: [] };
    if (targetTick <= snapshots[0]!.serverTick) {
      return { bodies: snapshots[0]!.bodies, extrapolatedBodyIds: [] };
    }

    const tracks = new Map<string, Array<{ tick: number; body: BodySnapshot }>>();
    const playerIds = new Set<string>();
    for (const snapshot of snapshots) {
      for (const player of snapshot.players)
        playerIds.add(`${player.id.index}:${player.id.generation}`);
      for (const body of snapshot.bodies) {
        const identity = key(body);
        const track = tracks.get(identity) ?? [];
        track.push({ tick: snapshot.serverTick, body });
        tracks.set(identity, track);
      }
    }

    const bodies: BodySnapshot[] = [];
    const extrapolatedBodyIds: BodySnapshot["id"][] = [];
    for (const track of tracks.values()) {
      let older: (typeof track)[number] | null = null;
      let newer: (typeof track)[number] | null = null;
      for (const state of track) {
        if (state.tick <= targetTick) older = state;
        if (state.tick >= targetTick) {
          newer = state;
          break;
        }
      }
      if (!older) continue;
      if (!newer) {
        const seconds = Math.min(targetTick - older.tick, MAX_EXTRAPOLATION_TICKS) / PHYSICS_HZ;
        const extrapolationState = playerIds.has(key(older.body))
          ? withInferredPlayerVelocity(track)
          : older.body;
        bodies.push(extrapolate(extrapolationState, seconds));
        if (targetTick > older.tick && moving(extrapolationState)) {
          extrapolatedBodyIds.push(older.body.id);
        }
        continue;
      }
      if (older.tick === newer.tick || targetTick === newer.tick) bodies.push(newer.body);
      else if (newer.body.flags) bodies.push(older.body);
      else
        bodies.push(
          interpolate(
            older.body,
            newer.body,
            (targetTick - older.tick) / (newer.tick - older.tick),
          ),
        );
    }
    return { bodies, extrapolatedBodyIds };
  };

  const sample = (targetTick: number): BodySnapshot[] => sampleWithMetadata(targetTick).bodies;

  return {
    get latestTick() {
      return latestTick();
    },
    push,
    observeServerTick,
    serverTickAt,
    sample,
    sampleWithMetadata,
  };
}

function withInferredPlayerVelocity(
  track: Array<{ tick: number; body: BodySnapshot }>,
): BodySnapshot {
  const current = track.at(-1)!;
  const previous = track.at(-2);
  if (!previous || current.tick <= previous.tick) return current.body;
  const seconds = (current.tick - previous.tick) / PHYSICS_HZ;
  const explicit = current.body.linearVelocity;
  const derivedX = (current.body.position.x - previous.body.position.x) / seconds;
  const derivedZ = (current.body.position.z - previous.body.position.z) / seconds;
  return {
    ...current.body,
    linearVelocity: {
      x: Math.abs(explicit?.x ?? 0) > 0.0001 ? explicit!.x : derivedX,
      y: explicit?.y ?? (current.body.position.y - previous.body.position.y) / seconds,
      z: Math.abs(explicit?.z ?? 0) > 0.0001 ? explicit!.z : derivedZ,
    },
  };
}

function moving(body: BodySnapshot): boolean {
  if (((body.flags ?? 0) & SNAPSHOT_FLAG_SLEEP) !== 0) return false;
  const linear = body.linearVelocity;
  const angular = body.angularVelocity;
  return (
    Math.hypot(linear?.x ?? 0, linear?.y ?? 0, linear?.z ?? 0) > 0.0001 ||
    Math.hypot(angular?.x ?? 0, angular?.y ?? 0, angular?.z ?? 0) > 0.0001
  );
}

function extrapolate(body: BodySnapshot, seconds: number): BodySnapshot {
  const velocity = body.linearVelocity ?? { x: 0, y: 0, z: 0 };
  return {
    ...body,
    position: {
      x: body.position.x + velocity.x * seconds,
      y: body.position.y + velocity.y * seconds,
      z: body.position.z + velocity.z * seconds,
    },
    rotation: integrate(body.rotation, body.angularVelocity ?? { x: 0, y: 0, z: 0 }, seconds),
  };
}

function integrate(rotation: Quat, angularVelocity: Vec3, seconds: number): Quat {
  const speed = Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z);
  if (speed < 0.000001) return rotation;
  const halfAngle = (speed * seconds) / 2;
  const scale = Math.sin(halfAngle) / speed;
  const x = angularVelocity.x * scale;
  const y = angularVelocity.y * scale;
  const z = angularVelocity.z * scale;
  const w = Math.cos(halfAngle);
  const result = {
    x: w * rotation.x + x * rotation.w + y * rotation.z - z * rotation.y,
    y: w * rotation.y - x * rotation.z + y * rotation.w + z * rotation.x,
    z: w * rotation.z + x * rotation.y - y * rotation.x + z * rotation.w,
    w: w * rotation.w - x * rotation.x - y * rotation.y - z * rotation.z,
  };
  const length = Math.hypot(result.x, result.y, result.z, result.w) || 1;
  return { x: result.x / length, y: result.y / length, z: result.z / length, w: result.w / length };
}
