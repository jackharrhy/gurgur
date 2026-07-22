import type { Vec3 } from "@gurgur/shared";
import type { PhysicsWorld } from "./index";

export const PLAYER_SPEED = 5;
export const PLAYER_GRAVITY = 10;
export const PLAYER_JUMP_SPEED = 5.2;
export const PLAYER_STEP_HEIGHT = 0.3;
export const PLAYER_GROUND_SNAP = 0.4;
const GROUND_PROBE = 0.06;
const EPSILON = 0.002;
const STANDING_HALF_SEGMENT = 0.55;
export const PLAYER_CROUCHED_HALF_SEGMENT = 0.25;
const CROUCH_HEIGHT_DELTA = STANDING_HALF_SEGMENT - PLAYER_CROUCHED_HALF_SEGMENT;
const WALKABLE_NORMAL_Y = Math.cos(50 * Math.PI / 180);

export type PlayerControllerInput = {
  moveX: number;
  moveZ: number;
  lookYaw: number;
  jumpCounter: number;
  crouch?: boolean;
  buttons?: number;
};

export type PlayerControllerState = {
  position: Vec3;
  verticalVelocity: number;
  yaw: number;
  grounded: boolean;
  lastJumpCounter: number;
  stepCooldown: number;
  crouched: boolean;
};

export type PlayerControllerWorld = Pick<PhysicsWorld,
  | "applyLinearImpulse"
  | "capsuleFits"
  | "castCapsule"
  | "moveCapsule"
  | "pointVelocity"
  | "raycastClosest"
>;

export function stepPlayerController(
  world: PlayerControllerWorld,
  state: PlayerControllerState,
  input: PlayerControllerInput,
  seconds: number,
): PlayerControllerState {
  let crouched = state.crouched;
  let basePosition = { ...state.position };
  const wantsCrouch = input.crouch ?? Boolean((input.buttons ?? 0) & 4);
  if (wantsCrouch && !crouched) {
    basePosition.y -= CROUCH_HEIGHT_DELTA;
    crouched = true;
  } else if (!wantsCrouch && crouched) {
    const standing = { ...basePosition, y: basePosition.y + CROUCH_HEIGHT_DELTA };
    const ceiling = world.raycastClosest(
      { x: basePosition.x, y: basePosition.y + PLAYER_CROUCHED_HALF_SEGMENT + 0.35 - 0.01, z: basePosition.z },
      { x: 0, y: CROUCH_HEIGHT_DELTA + 0.02, z: 0 },
    );
    if (!ceiling && world.capsuleFits(standing, { halfSegment: STANDING_HALF_SEGMENT })) {
      basePosition = standing;
      crouched = false;
    }
  }
  const halfSegment = crouched ? PLAYER_CROUCHED_HALF_SEGMENT : STANDING_HALF_SEGMENT;
  const halfHeight = halfSegment + 0.35;
  const capsule = { halfSegment };
  const support = state.grounded ? world.raycastClosest(
    basePosition,
    { x: 0, y: -(halfHeight + 0.12), z: 0 },
  ) : null;
  const supportVelocity = support && support.normal.y >= WALKABLE_NORMAL_Y
    ? world.pointVelocity(support.body, support.point)
    : { x: 0, y: 0, z: 0 };
  const start = world.moveCapsule(basePosition, {
    x: supportVelocity.x * seconds,
    y: supportVelocity.y * seconds,
    z: supportVelocity.z * seconds,
  }, capsule);
  const groundHit = world.raycastClosest(start, { x: 0, y: -(halfHeight + PLAYER_GROUND_SNAP + 0.02), z: 0 });
  const groundProbe = groundHit && groundHit.normal.y >= WALKABLE_NORMAL_Y
    ? world.castCapsule(start, { x: 0, y: -GROUND_PROBE, z: 0 }, capsule)
    : world.moveCapsule(start, { x: 0, y: -GROUND_PROBE, z: 0 }, capsule);
  const trustedStepGround = state.grounded && state.stepCooldown > 0;
  const wasGrounded = trustedStepGround || (
    groundProbe.y > start.y - GROUND_PROBE + EPSILON
    && !!groundHit
    && groundHit.normal.y >= WALKABLE_NORMAL_Y
  );
  const jumped = input.jumpCounter !== state.lastJumpCounter && wasGrounded;
  let verticalVelocity = jumped
    ? PLAYER_JUMP_SPEED
    : trustedStepGround
      ? 0
      : state.verticalVelocity - PLAYER_GRAVITY * seconds;

  const verticalStart = jumped ? start : trustedStepGround ? start : wasGrounded ? groundProbe : start;
  const verticalTarget = world.moveCapsule(verticalStart, { x: 0, y: verticalVelocity * seconds, z: 0 }, capsule);
  const verticalBlocked = verticalVelocity <= 0
    && Math.abs(verticalTarget.y - verticalStart.y - verticalVelocity * seconds) > EPSILON;
  if (verticalBlocked) verticalVelocity = 0;

  const axesLength = Math.hypot(input.moveX, input.moveZ);
  const scale = axesLength > 1 ? 1 / axesLength : 1;
  const moveX = input.moveX * scale;
  const moveZ = input.moveZ * scale;
  const sin = Math.sin(input.lookYaw);
  const cos = Math.cos(input.lookYaw);
  const horizontal = {
    x: (moveX * cos - moveZ * sin) * PLAYER_SPEED * seconds,
    y: 0,
    z: (-moveX * sin - moveZ * cos) * PLAYER_SPEED * seconds,
  };
  let position = world.moveCapsule(verticalTarget, horizontal, capsule);
  let deferredStep = false;
  let stepSupported = false;

  const desiredDistance = Math.hypot(horizontal.x, horizontal.z);
  const directDistance = horizontalDistance(verticalTarget, position);
  if (desiredDistance > EPSILON && directDistance + EPSILON < desiredDistance) {
    const direction = { x: horizontal.x / desiredDistance, z: horizontal.z / desiredDistance };
    const pushTarget = world.raycastClosest(verticalTarget, {
      x: direction.x * (0.35 + desiredDistance + 0.02),
      y: 0,
      z: direction.z * (0.35 + desiredDistance + 0.02),
    });
    if (pushTarget) world.applyLinearImpulse(pushTarget.body, {
      x: direction.x * Math.min(1, desiredDistance * 12),
      y: 0,
      z: direction.z * Math.min(1, desiredDistance * 12),
    });
  }
  let stepCooldown = Math.max(0, state.stepCooldown - 1);
  if (!jumped && wasGrounded && stepCooldown === 0 && desiredDistance > EPSILON && directDistance + EPSILON < desiredDistance) {
    const direction = { x: horizontal.x / desiredDistance, z: horizontal.z / desiredDistance };
    const ahead = PLAYER_STEP_HEIGHT + 0.08;
    const support = world.raycastClosest(
      {
        x: verticalTarget.x + direction.x * ahead,
        y: verticalTarget.y + PLAYER_STEP_HEIGHT + 0.1,
        z: verticalTarget.z + direction.z * ahead,
      },
      { x: 0, y: -(halfHeight + PLAYER_STEP_HEIGHT + 0.2), z: 0 },
    );
    const currentFloor = groundProbe.y - halfHeight;
    const rise = support ? support.point.y - currentFloor : Infinity;
    if (support && support.normal.y >= WALKABLE_NORMAL_Y && rise > EPSILON && rise <= PLAYER_STEP_HEIGHT + 0.01) {
      const raised = world.moveCapsule(verticalTarget, { x: 0, y: rise, z: 0 }, capsule);
      const across = world.moveCapsule(raised, horizontal, capsule);
      if (
        raised.y >= verticalTarget.y + rise - EPSILON
        && Math.abs(across.y - raised.y) < 0.01
        && horizontalDistance(verticalTarget, across) > directDistance + EPSILON
      ) {
        position = across;
        deferredStep = true;
        stepSupported = true;
        stepCooldown = 6;
      }
    }
  }

  let grounded = stepSupported;
  if (!deferredStep && !jumped && verticalVelocity <= 0 && (wasGrounded || verticalBlocked)) {
    const snapDistance = stepCooldown > 0 ? GROUND_PROBE : PLAYER_GROUND_SNAP;
    const snappedGround = world.raycastClosest(position, {
      x: 0, y: -(halfHeight + snapDistance + 0.02), z: 0,
    });
    const walkable = !!snappedGround && snappedGround.normal.y >= WALKABLE_NORMAL_Y;
    const snapped = walkable
      ? world.castCapsule(position, { x: 0, y: -snapDistance, z: 0 }, capsule)
      : world.moveCapsule(position, { x: 0, y: -snapDistance, z: 0 }, capsule);
    const fall = position.y - snapped.y;
    grounded = fall < snapDistance - EPSILON
      && walkable;
    if (grounded) {
      position = snapped;
      verticalVelocity = 0;
    }
  }

  return {
    position,
    verticalVelocity,
    yaw: input.lookYaw,
    grounded,
    lastJumpCounter: input.jumpCounter,
    stepCooldown,
    crouched,
  };
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}
