import type { BodySnapshot, Quat, Vec3 } from "@gurgur/engine";

const TELEPORT_METRES = 0.75;

type TickPose = {
  tick: number;
  body: BodySnapshot;
};

export type PredictedPoseTimeline = {
  push(body: BodySnapshot, tick: number): void;
  sample(tick: number): BodySnapshot | null;
  clear(): void;
};

export function createPredictedPoseTimeline(): PredictedPoseTimeline {
  let previous: TickPose | null = null;
  let current: TickPose | null = null;

  const sample = (tick: number): BodySnapshot | null => {
    if (!current) return null;
    if (!previous || tick >= current.tick) return clone(current.body);
    if (tick <= previous.tick) return clone(previous.body);
    const amount = (tick - previous.tick) / (current.tick - previous.tick);
    return {
      ...current.body,
      position: mixVec3(previous.body.position, current.body.position, amount),
      rotation: mixQuat(previous.body.rotation, current.body.rotation, amount),
    };
  };

  const push = (body: BodySnapshot, tick: number): void => {
    if (!Number.isSafeInteger(tick) || tick < 0)
      throw new Error("predicted presentation tick is invalid");
    const next = { tick, body: clone(body) };
    if (
      !current ||
      key(current.body) !== key(body) ||
      tick < current.tick ||
      distance(current.body.position, body.position) >= TELEPORT_METRES
    ) {
      previous = next;
      current = next;
      return;
    }
    if (tick === current.tick) {
      current = next;
      return;
    }
    previous = current;
    current = next;
  };

  const clear = (): void => {
    previous = null;
    current = null;
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
  const inverseLength = 1 / (Math.hypot(mixed.x, mixed.y, mixed.z, mixed.w) || 1);
  return {
    x: mixed.x * inverseLength,
    y: mixed.y * inverseLength,
    z: mixed.z * inverseLength,
    w: mixed.w * inverseLength,
  };
}
