import type { BodyState, Quat, RuntimeId, Vec3 } from "@gurgur/engine";

export type CapsuleShape = { radius: number; halfSegment: number };
export type RuntimeBodyRef = { id: RuntimeId; entityIndex: number };
export type RayHit = { point: Vec3; normal: Vec3; fraction: number; body: RuntimeId };
export type BodyTargetOptions = {
  targetPosition: Vec3;
  targetRotation: Quat;
  linearGain: number;
  maxLinearSpeed: number;
  maxLinearAcceleration: number;
  angularGain: number;
  maxAngularSpeed: number;
  maxAngularAcceleration: number;
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
  raycast(
    origin: Vec3,
    displacement: Vec3,
    options?: { ignoreBodies?: readonly RuntimeId[] },
  ): RayHit | null;

  createPlayerProxy(position: Vec3, shape: CapsuleShape): RuntimeId;
  updatePlayerProxy(id: RuntimeId, position: Vec3, yaw: number): void;
  destroyBody(id: RuntimeId): void;

  driveBodyToTarget(id: RuntimeId, options: BodyTargetOptions): boolean;
  requestSave(): void;
};
