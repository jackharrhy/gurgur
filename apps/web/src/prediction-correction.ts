import { Quaternion } from "three";
import type { BodySnapshot, Vec3 } from "@gurgur/engine";

type Pose = Pick<BodySnapshot, "position" | "rotation">;

export type PredictionCorrection = {
  position: Vec3;
  rotation: Pose["rotation"];
  startedAtMs: number | null;
};

export const PREDICTION_CORRECTION_MS = 100;
export const PREDICTION_CORRECTION_MAX_FRAME_STEP_METRES = 0.2;
const PREDICTION_HARD_SNAP_METRES = 1;

export function predictionCorrection(from: Pose, to: Pose): PredictionCorrection {
  const rotation = quaternion(from.rotation).multiply(quaternion(to.rotation).invert());
  return {
    position: {
      x: from.position.x - to.position.x,
      y: from.position.y - to.position.y,
      z: from.position.z - to.position.z,
    },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    startedAtMs: null,
  };
}

export function correctedPredictionPose(
  body: Pose,
  correction: PredictionCorrection,
  nowMs: number,
  maximumStepFrom?: Vec3,
): Pose {
  correction.startedAtMs ??= nowMs;
  const remaining =
    1 - Math.max(0, Math.min(1, (nowMs - correction.startedAtMs) / PREDICTION_CORRECTION_MS));
  const rotation = new Quaternion()
    .slerp(quaternion(correction.rotation), remaining)
    .multiply(quaternion(body.rotation));
  const position = {
    x: body.position.x + correction.position.x * remaining,
    y: body.position.y + correction.position.y * remaining,
    z: body.position.z + correction.position.z * remaining,
  };
  if (maximumStepFrom) {
    const distance = Math.hypot(
      position.x - maximumStepFrom.x,
      position.y - maximumStepFrom.y,
      position.z - maximumStepFrom.z,
    );
    if (distance > PREDICTION_CORRECTION_MAX_FRAME_STEP_METRES) {
      const amount = PREDICTION_CORRECTION_MAX_FRAME_STEP_METRES / distance;
      position.x = maximumStepFrom.x + (position.x - maximumStepFrom.x) * amount;
      position.y = maximumStepFrom.y + (position.y - maximumStepFrom.y) * amount;
      position.z = maximumStepFrom.z + (position.z - maximumStepFrom.z) * amount;
    }
  }
  return {
    position,
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
  };
}

export function reconcilePredictionCorrection(
  previous: Pose,
  reconciled: Pose,
  correction: PredictionCorrection | null,
  nowMs: number,
  allowLargeError: boolean,
): PredictionCorrection | null {
  const distance = Math.hypot(
    previous.position.x - reconciled.position.x,
    previous.position.y - reconciled.position.y,
    previous.position.z - reconciled.position.z,
  );
  if (distance > PREDICTION_HARD_SNAP_METRES && !allowLargeError) return null;
  const angle = quaternion(previous.rotation).angleTo(quaternion(reconciled.rotation));
  if (distance <= 0.001 && angle <= 0.001) return correction;
  const from = correction ? correctedPredictionPose(previous, correction, nowMs) : previous;
  return { ...predictionCorrection(from, reconciled), startedAtMs: nowMs };
}

function quaternion(rotation: Pose["rotation"]): Quaternion {
  return new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
}
