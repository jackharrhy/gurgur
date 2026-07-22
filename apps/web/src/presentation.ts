import { PHYSICS_DT, type BodySnapshot, type Quat, type Vec3 } from "@gurgur/shared";

const FRAME_MILLISECONDS = PHYSICS_DT * 1_000;
const TELEPORT_METRES = 0.75;

export type PredictedPoseTimeline = {
  push(body: BodySnapshot, now: number): void;
  sample(now: number): BodySnapshot | null;
  clear(): void;
};

export function createPredictedPoseTimeline(): PredictedPoseTimeline {
  let previous: BodySnapshot | null = null;
  let current: BodySnapshot | null = null;
  let receivedAt = 0;

  const sample = (now: number): BodySnapshot | null => {
    if (!previous || !current) return null;
    const amount = clamp((now - receivedAt) / FRAME_MILLISECONDS, 0, 1);
    return {
      ...current,
      position: mixVec3(previous.position, current.position, amount),
      rotation: mixQuat(previous.rotation, current.rotation, amount),
    };
  };

  const push = (body: BodySnapshot, now: number): void => {
    const presented = sample(now);
    const teleport =
      !presented ||
      key(presented) !== key(body) ||
      distance(presented.position, body.position) >= TELEPORT_METRES;
    previous = teleport ? clone(body) : presented;
    current = clone(body);
    receivedAt = now;
  };

  const clear = (): void => {
    previous = null;
    current = null;
    receivedAt = 0;
  };

  return { push, sample, clear };
}

export function mergeBodySamples(
  authoritative: BodySnapshot[],
  predicted: BodySnapshot[],
): BodySnapshot[] {
  const predictedById = new Map(predicted.map((body) => [key(body), body]));
  const merged = authoritative.map((body) => predictedById.get(key(body)) ?? body);
  const authoritativeIds = new Set(authoritative.map(key));
  for (const body of predicted) if (!authoritativeIds.has(key(body))) merged.push(body);
  return merged;
}

function clone(body: BodySnapshot): BodySnapshot {
  return {
    ...body,
    id: { ...body.id },
    position: { ...body.position },
    rotation: { ...body.rotation },
    linearVelocity: body.linearVelocity ? { ...body.linearVelocity } : undefined,
    angularVelocity: body.angularVelocity ? { ...body.angularVelocity } : undefined,
  };
}

function key(body: BodySnapshot): string {
  return `${body.id.index}:${body.id.generation}`;
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function mixVec3(a: Vec3, b: Vec3, amount: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    z: a.z + (b.z - a.z) * amount,
  };
}
function mixQuat(a: Quat, b: Quat, amount: number): Quat {
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const mixed = {
    x: a.x + (b.x * sign - a.x) * amount,
    y: a.y + (b.y * sign - a.y) * amount,
    z: a.z + (b.z * sign - a.z) * amount,
    w: a.w + (b.w * sign - a.w) * amount,
  };
  const inverseLength = 1 / Math.hypot(mixed.x, mixed.y, mixed.z, mixed.w);
  return {
    x: mixed.x * inverseLength,
    y: mixed.y * inverseLength,
    z: mixed.z * inverseLength,
    w: mixed.w * inverseLength,
  };
}
