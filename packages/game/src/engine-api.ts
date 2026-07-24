import type { BodyState, ConstraintId, RuntimeId, Vec3 } from "@gurgur/engine";

export type CapsuleShape = { radius: number; halfSegment: number };
export type RuntimeBodyRef = { id: RuntimeId; entityIndex: number };
export type RayHit = { point: Vec3; normal: Vec3; fraction: number; body: RuntimeId };
export type GrabConstraintOptions = {
  bodyA: RuntimeId;
  bodyB: RuntimeId;
  worldAnchorA: Vec3;
  worldAnchorB: Vec3;
  length: number;
  hertz?: number;
  dampingRatio?: number;
  maxForce?: number;
};

export type GameEngine = {
  readonly tick: number;
  readonly dt: number;
  readonly bodies: {
    forEntity(entityIndex: number): RuntimeBodyRef | null;
    resolve(id: RuntimeId): RuntimeBodyRef | null;
    state(id: RuntimeId): BodyState;
  };

  setKinematicTarget(id: RuntimeId, position: Vec3): void;
  setBodyAwake(id: RuntimeId, awake: boolean): void;
  raycast(origin: Vec3, displacement: Vec3): RayHit | null;

  createPlayerProxy(position: Vec3, shape: CapsuleShape): RuntimeId;
  updatePlayerProxy(id: RuntimeId, position: Vec3, yaw: number): void;
  destroyBody(id: RuntimeId): void;

  createGrabConstraint(options: GrabConstraintOptions): ConstraintId;
  destroyConstraint(id: ConstraintId): void;
  requestSave(): void;
};
