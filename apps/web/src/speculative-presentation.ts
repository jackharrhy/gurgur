import {
  PHYSICS_HZ,
  type BodySnapshot,
  type Quat,
  type RuntimeId,
  type Vec3,
} from "@gurgur/engine";

const TARGET_BLEND_MS = 1_000 / PHYSICS_HZ;
const RELEASE_POSITION_CORRECTION_METRES_PER_SECOND = 2;
const RELEASE_ROTATION_CORRECTION_RADIANS_PER_SECOND = Math.PI * 2;
const POSITION_EPSILON = 0.001;
const ROTATION_EPSILON = 0.001;

type Pose = {
  position: Vec3;
  rotation: Quat;
};

type ActiveView = {
  key: string;
  from: Pose;
  target: Pose;
  targetAtMs: number;
};

type ReleasedView = {
  key: string;
  pose: Pose;
  positionOffset: Vec3 | null;
  rotationOffset: Quat | null;
  sampledAtMs: number;
};

export type SpeculativePresentationDiagnostics = {
  active: string | null;
  reconciling: string | null;
  positionErrorMetres: number;
  rotationErrorRadians: number;
  maximumPositionErrorMetres: number;
  maximumRotationErrorRadians: number;
};

export class SpeculativeHeldPresenter {
  #active: ActiveView | null = null;
  #released: ReleasedView | null = null;
  #positionErrorMetres = 0;
  #rotationErrorRadians = 0;
  #maximumPositionErrorMetres = 0;
  #maximumRotationErrorRadians = 0;

  begin(id: RuntimeId, pose: Pose, nowMs: number): void {
    if (!finiteTime(nowMs) || !finitePose(pose)) return;
    const key = idKey(id);
    const initial = clonePose(pose);
    this.#active = { key, from: initial, target: clonePose(initial), targetAtMs: nowMs };
    this.#released = null;
    this.#clearErrors();
  }

  target(id: RuntimeId, pose: Pose, nowMs: number): boolean {
    if (!finiteTime(nowMs) || !finitePose(pose) || this.#active?.key !== idKey(id)) return false;
    const current = this.#activePose(nowMs);
    this.#active = {
      key: this.#active.key,
      from: current,
      target: clonePose(pose),
      targetAtMs: nowMs,
    };
    return true;
  }

  end(id: RuntimeId, nowMs: number): void {
    if (!finiteTime(nowMs)) return;
    const key = idKey(id);
    if (this.#active?.key !== key) return;
    this.#released = {
      key,
      pose: this.#activePose(nowMs),
      positionOffset: null,
      rotationOffset: null,
      sampledAtMs: nowMs,
    };
    this.#active = null;
  }

  remove(id: RuntimeId): void {
    const key = idKey(id);
    if (this.#active?.key === key || this.#released?.key === key) {
      this.#active = null;
      this.#released = null;
      this.#clearErrors();
    }
  }

  reset(): void {
    this.#active = null;
    this.#released = null;
    this.#clearErrors();
  }

  present(body: BodySnapshot, nowMs: number): BodySnapshot {
    if (!finiteTime(nowMs)) return body;
    const key = idKey(body.id);
    if (this.#active?.key === key) {
      const pose = this.#activePose(nowMs);
      this.#observeError(pose, body);
      return withPose(body, pose);
    }
    if (this.#released?.key !== key) return body;

    const released = this.#released;
    if (!released.positionOffset || !released.rotationOffset) {
      released.positionOffset = subtract(released.pose.position, body.position);
      released.rotationOffset = multiplyQuat(released.pose.rotation, inverseQuat(body.rotation));
      released.sampledAtMs = nowMs;
    } else {
      const seconds = Math.max(0, (nowMs - released.sampledAtMs) / 1_000);
      released.positionOffset = moveVectorTowardZero(
        released.positionOffset,
        RELEASE_POSITION_CORRECTION_METRES_PER_SECOND * seconds,
      );
      released.rotationOffset = rotateTowardIdentity(
        released.rotationOffset,
        RELEASE_ROTATION_CORRECTION_RADIANS_PER_SECOND * seconds,
      );
      released.sampledAtMs = nowMs;
    }

    if (
      length(released.positionOffset) <= POSITION_EPSILON &&
      quatAngle(released.rotationOffset) <= ROTATION_EPSILON
    ) {
      this.#released = null;
      this.#observeError(body, body);
      return body;
    }
    const pose = {
      position: add(body.position, released.positionOffset),
      rotation: normalizeQuat(multiplyQuat(released.rotationOffset, body.rotation)),
    };
    this.#observeError(pose, body);
    return withPose(body, pose);
  }

  diagnostics(): SpeculativePresentationDiagnostics {
    return {
      active: this.#active?.key ?? null,
      reconciling: this.#released?.key ?? null,
      positionErrorMetres: this.#positionErrorMetres,
      rotationErrorRadians: this.#rotationErrorRadians,
      maximumPositionErrorMetres: this.#maximumPositionErrorMetres,
      maximumRotationErrorRadians: this.#maximumRotationErrorRadians,
    };
  }

  #observeError(pose: Pose, body: BodySnapshot): void {
    this.#positionErrorMetres = length(subtract(pose.position, body.position));
    this.#rotationErrorRadians = quatAngle(multiplyQuat(pose.rotation, inverseQuat(body.rotation)));
    this.#maximumPositionErrorMetres = Math.max(
      this.#maximumPositionErrorMetres,
      this.#positionErrorMetres,
    );
    this.#maximumRotationErrorRadians = Math.max(
      this.#maximumRotationErrorRadians,
      this.#rotationErrorRadians,
    );
  }

  #clearErrors(): void {
    this.#positionErrorMetres = 0;
    this.#rotationErrorRadians = 0;
    this.#maximumPositionErrorMetres = 0;
    this.#maximumRotationErrorRadians = 0;
  }

  #activePose(nowMs: number): Pose {
    const active = this.#active!;
    const amount = clamp((nowMs - active.targetAtMs) / TARGET_BLEND_MS, 0, 1);
    return {
      position: mixVec3(active.from.position, active.target.position, amount),
      rotation: slerp(active.from.rotation, active.target.rotation, amount),
    };
  }
}

function withPose(body: BodySnapshot, pose: Pose): BodySnapshot {
  return {
    ...body,
    id: { ...body.id },
    position: { ...pose.position },
    rotation: { ...pose.rotation },
    ...(body.linearVelocity ? { linearVelocity: { ...body.linearVelocity } } : {}),
    ...(body.angularVelocity ? { angularVelocity: { ...body.angularVelocity } } : {}),
  };
}

function clonePose(pose: Pose): Pose {
  return {
    position: { ...pose.position },
    rotation: normalizeQuat(pose.rotation),
  };
}

function finiteTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function finitePose(pose: Pose): boolean {
  return (
    [pose.position.x, pose.position.y, pose.position.z].every(Number.isFinite) &&
    [pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w].every(Number.isFinite)
  );
}

function idKey(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function mixVec3(a: Vec3, b: Vec3, amount: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    z: a.z + (b.z - a.z) * amount,
  };
}

function length(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function moveVectorTowardZero(value: Vec3, maximumDistance: number): Vec3 {
  const distance = length(value);
  if (distance <= maximumDistance || distance <= Number.EPSILON) return { x: 0, y: 0, z: 0 };
  const scale = (distance - maximumDistance) / distance;
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

function inverseQuat(value: Quat): Quat {
  const normalized = normalizeQuat(value);
  return { x: -normalized.x, y: -normalized.y, z: -normalized.z, w: normalized.w };
}

function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function normalizeQuat(value: Quat): Quat {
  const magnitude = Math.hypot(value.x, value.y, value.z, value.w);
  if (magnitude <= Number.EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: value.x / magnitude,
    y: value.y / magnitude,
    z: value.z / magnitude,
    w: value.w / magnitude,
  };
}

function quatAngle(value: Quat): number {
  return 2 * Math.acos(clamp(Math.abs(normalizeQuat(value).w), -1, 1));
}

function rotateTowardIdentity(value: Quat, maximumAngle: number): Quat {
  const angle = quatAngle(value);
  if (angle <= maximumAngle || angle <= Number.EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  return slerp(value, { x: 0, y: 0, z: 0, w: 1 }, maximumAngle / angle);
}

function slerp(a: Quat, b: Quat, amount: number): Quat {
  const first = normalizeQuat(a);
  let second = normalizeQuat(b);
  let cosine = first.x * second.x + first.y * second.y + first.z * second.z + first.w * second.w;
  if (cosine < 0) {
    cosine = -cosine;
    second = { x: -second.x, y: -second.y, z: -second.z, w: -second.w };
  }
  if (cosine > 0.9995)
    return normalizeQuat({
      x: first.x + (second.x - first.x) * amount,
      y: first.y + (second.y - first.y) * amount,
      z: first.z + (second.z - first.z) * amount,
      w: first.w + (second.w - first.w) * amount,
    });
  const angle = Math.acos(clamp(cosine, -1, 1));
  const sine = Math.sin(angle);
  const firstWeight = Math.sin((1 - amount) * angle) / sine;
  const secondWeight = Math.sin(amount * angle) / sine;
  return normalizeQuat({
    x: first.x * firstWeight + second.x * secondWeight,
    y: first.y * firstWeight + second.y * secondWeight,
    z: first.z * firstWeight + second.z * secondWeight,
    w: first.w * firstWeight + second.w * secondWeight,
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
