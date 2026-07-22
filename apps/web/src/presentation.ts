import { PHYSICS_DT, type BodySnapshot, type Quat, type Vec3 } from "@gurgur/shared";

const FRAME_MILLISECONDS = PHYSICS_DT * 1_000;
const TELEPORT_METRES = 0.75;

export class PredictedPoseBuffer {
  #previous: BodySnapshot | null = null;
  #current: BodySnapshot | null = null;
  #receivedAt = 0;

  push(body: BodySnapshot, now: number): void {
    const presented = this.sample(now);
    const teleport = !presented
      || key(presented) !== key(body)
      || distance(presented.position, body.position) >= TELEPORT_METRES;
    this.#previous = teleport ? clone(body) : presented;
    this.#current = clone(body);
    this.#receivedAt = now;
  }

  sample(now: number): BodySnapshot | null {
    if (!this.#previous || !this.#current) return null;
    const amount = clamp((now - this.#receivedAt) / FRAME_MILLISECONDS, 0, 1);
    return {
      ...this.#current,
      position: mixVec3(this.#previous.position, this.#current.position, amount),
      rotation: mixQuat(this.#previous.rotation, this.#current.rotation, amount),
    };
  }

  clear(): void {
    this.#previous = null;
    this.#current = null;
    this.#receivedAt = 0;
  }
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

function key(body: BodySnapshot): string { return `${body.id.index}:${body.id.generation}`; }
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
function distance(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
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
