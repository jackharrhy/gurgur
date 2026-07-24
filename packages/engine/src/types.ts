export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export type RuntimeId = {
  index: number;
  generation: number;
};

export type BodySnapshot = {
  id: RuntimeId;
  position: Vec3;
  rotation: Quat;
  linearVelocity?: Vec3;
  angularVelocity?: Vec3;
  flags?: number;
};

export type ConstraintId = { index: number; generation: number };
export type BodyKind = "static" | "kinematic" | "dynamic";

export type BodyState = BodySnapshot & {
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  awake: boolean;
};

export type PhysicsStepEvents = {
  sensorBegin: Array<{ sensor: RuntimeId; visitor: RuntimeId }>;
  sensorEnd: Array<{ sensor: RuntimeId; visitor: RuntimeId }>;
  contactBegin: Array<{ a: RuntimeId; b: RuntimeId }>;
  contactEnd: Array<{ a: RuntimeId; b: RuntimeId }>;
  contactHit: Array<{
    a: RuntimeId;
    b: RuntimeId;
    point: Vec3;
    normal: Vec3;
    approachSpeed: number;
  }>;
  moved: Array<{ body: RuntimeId; position: Vec3; rotation: Quat; fellAsleep: boolean }>;
};

export type PhysicsDebugDraw = {
  primitives: PhysicsDebugPrimitive[];
  truncated: boolean;
};

export type Snapshot = {
  worldEpoch: number;
  serverTick: number;
  bodies: BodySnapshot[];
  players: PlayerStateSnapshot[];
};

export type PhysicsDebugPrimitive =
  | { kind: "bounds"; lower: Vec3; upper: Vec3; color: number }
  | { kind: "segment"; from: Vec3; to: Vec3; color: number }
  | { kind: "point"; position: Vec3; size: number; color: number };

export type PhysicsDebugFrame = {
  worldEpoch: number;
  serverTick: number;
  primitives: PhysicsDebugPrimitive[];
  truncated: boolean;
};

export type PlayerStateSnapshot = {
  id: RuntimeId;
  position: Vec3;
  yaw: number;
  verticalVelocity: number;
  grounded: boolean;
  lastProcessedInputSequence: number;
  lastJumpCounter: number;
  stepCooldown: number;
  crouched: boolean;
};

export type WelcomeMessage = {
  type: "welcome";
  protocolVersion: 1;
  worldEpoch: number;
  playerId: RuntimeId;
  mapRevision: string;
  physicsHz: number;
  snapshotHz: number;
  sessionToken: string;
  socketGeneration: number;
};

export type HelloMessage = {
  type: "hello";
  protocolVersion: 1;
  mapRevision: string | null;
  worldEpoch: number | null;
  sessionToken: string | null;
  socketGeneration: number;
};

export type PingMessage = {
  type: "ping";
  protocolVersion: 1;
  worldEpoch: number;
  nonce: number;
  sentAtMs: number;
};

export type PongMessage = {
  type: "pong";
  protocolVersion: 1;
  worldEpoch: number;
  nonce: number;
  sentAtMs: number;
  serverTick: number;
};

export type RtcOfferMessage = {
  type: "rtc-offer";
  protocolVersion: 1;
  worldEpoch: number;
  description: { type: "offer"; sdp: string };
  iceServers: Array<{ urls: string; username?: string; credential?: string }>;
};

export type RtcAnswerMessage = {
  type: "rtc-answer";
  protocolVersion: 1;
  worldEpoch: number;
  description: { type: "answer"; sdp: string };
};

export type ClientControlMessage = HelloMessage | PingMessage | RtcAnswerMessage;
export type ServerControlMessage = WelcomeMessage | PongMessage | RtcOfferMessage;

export type InputCommand = {
  type: "input";
  protocolVersion: 1;
  worldEpoch: number;
  sequence: number;
  clientTick: number;
  moveX: number;
  moveZ: number;
  lookYaw: number;
  lookPitch: number;
  buttons: number;
  jumpCounter: number;
  interactCounter: number;
  interactTarget: RuntimeId | null;
  primaryCounter: number;
};

export type ClientPacket = ClientControlMessage | InputCommand;
