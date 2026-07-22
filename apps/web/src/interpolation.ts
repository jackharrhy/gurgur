import { PHYSICS_HZ, type BodySnapshot, type Quat, type Snapshot, type Vec3 } from "@gurgur/shared";

const HISTORY_LENGTH = 11;
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
    bx = -bx; by = -by; bz = -bz; bw = -bw;
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
};

export function createSnapshotTimeline(): SnapshotTimeline {
  let worldEpoch: number | null = null;
  let snapshots: Snapshot[] = [];
  let clockTick: number | null = null;
  let clockAtMs = 0;

  const latestTick = (): number | null => snapshots.at(-1)?.serverTick ?? null;

  const serverTickAt = (nowMs: number): number => {
    if (clockTick === null) return latestTick() ?? 0;
    return clockTick + Math.max(0, nowMs - clockAtMs) * PHYSICS_HZ / 1_000;
  };

  const observeServerTick = (serverTick: number, receivedAtMs: number, oneWayDelayMs: number): void => {
    const candidate = serverTick + oneWayDelayMs * PHYSICS_HZ / 1_000;
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
    if (snapshots.length > HISTORY_LENGTH) snapshots.shift();
    observeServerTick(snapshot.serverTick, receivedAtMs, oneWayDelayMs);
  };

  const sample = (targetTick: number): BodySnapshot[] => {
    if (snapshots.length === 0) return [];
    let older = snapshots[0]!;
    let newer = snapshots.at(-1)!;
    for (let index = 1; index < snapshots.length; index += 1) {
      const candidate = snapshots[index]!;
      if (candidate.serverTick >= targetTick) {
        newer = candidate;
        older = snapshots[index - 1]!;
        break;
      }
    }
    if (targetTick <= older.serverTick) return older.bodies;
    if (older === newer) {
      const seconds = Math.min(targetTick - newer.serverTick, MAX_EXTRAPOLATION_TICKS) / PHYSICS_HZ;
      return newer.bodies.map((body) => extrapolate(body, seconds));
    }
    if (targetTick > newer.serverTick) {
      const seconds = Math.min(targetTick - newer.serverTick, MAX_EXTRAPOLATION_TICKS) / PHYSICS_HZ;
      return newer.bodies.map((body) => extrapolate(body, seconds));
    }
    if (targetTick === newer.serverTick) return newer.bodies;
    const amount = (targetTick - older.serverTick) / (newer.serverTick - older.serverTick);
    const newBodies = new Map(newer.bodies.map((body) => [key(body), body]));
    return older.bodies.map((body) => {
      const next = newBodies.get(key(body));
      return next ? (next.flags ? body : interpolate(body, next, amount)) : body;
    });
  };

  return {
    get latestTick() { return latestTick(); },
    push,
    observeServerTick,
    serverTickAt,
    sample,
  };
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
  const halfAngle = speed * seconds / 2;
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
