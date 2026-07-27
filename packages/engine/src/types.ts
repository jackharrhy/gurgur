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

export type JointFrame = {
  position: Vec3;
  rotation: Quat;
};

export type JointBodies = {
  bodyA: RuntimeId;
  bodyB?: RuntimeId;
  localFrameA: JointFrame;
  localFrameB: JointFrame;
  collideConnected?: boolean;
};

export type RevoluteMotor =
  | { mode: "none" }
  | { mode: "friction"; maxTorque: number }
  | {
      mode: "target-angle";
      targetAngle: number;
      hertz: number;
      dampingRatio: number;
    }
  | { mode: "target-velocity"; targetVelocity: number; maxTorque: number };

export type PrismaticMotor =
  | { mode: "none" }
  | {
      mode: "target-position";
      targetPosition: number;
      hertz: number;
      dampingRatio: number;
    }
  | { mode: "target-velocity"; targetVelocity: number; maxForce: number };

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

export type TransferPolicy = "fixed" | "grab-lease";

export type NetworkObjectKind = "body" | "player";

export type NetworkBodyState = {
  kind: "body";
  id: RuntimeId;
  authorityVersion: number;
  stateSequence: number;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  flags: number;
};

export type NetworkPlayerState = {
  kind: "player";
  id: RuntimeId;
  authorityVersion: number;
  stateSequence: number;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  flags: number;
  yaw: number;
  verticalVelocity: number;
  grounded: boolean;
  crouched: boolean;
  lastJumpCounter: number;
  stepCooldown: number;
};

export type NetworkObjectState = NetworkBodyState | NetworkPlayerState;

export type StateDelta = {
  kind: NetworkObjectKind;
  id: RuntimeId;
  authorityVersion: number;
  stateSequence: number;
  baselineSequence: number | null;
  fieldMask: number;
  position?: Vec3;
  rotation?: Quat;
  linearVelocity?: Vec3;
  angularVelocity?: Vec3;
  flags?: number;
  player?: {
    yaw: number;
    verticalVelocity: number;
    grounded: boolean;
    crouched: boolean;
    lastJumpCounter: number;
    stepCooldown: number;
  };
};

export type OwnedStatePacket = {
  worldEpoch: number;
  states: NetworkObjectState[];
};

export type OwnerCommitPacket = OwnedStatePacket;

export type StateClusterPacket = {
  worldEpoch: number;
  clusterSequence: number;
  states: StateDelta[];
};

export type StateAckPacket = {
  worldEpoch: number;
  entries: Array<{
    id: RuntimeId;
    authorityVersion: number;
    stateSequence: number;
  }>;
};

export type BootstrapStatePacket = {
  worldEpoch: number;
  states: NetworkObjectState[];
};

export type OwnershipChangedPacket = {
  worldEpoch: number;
  requestId: number | null;
  id: RuntimeId;
  ownerPlayerId: RuntimeId | null;
  authorityVersion: number;
  state: NetworkObjectState;
};

export type OwnershipDropPacket = {
  worldEpoch: number;
  id: RuntimeId;
  authorityVersion: number;
  state: NetworkBodyState;
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
  protocolVersion: 5;
  worldEpoch: number;
  playerId: RuntimeId;
  mapRevision: string;
  physicsHz: number;
  stateHz: number;
  sessionToken: string;
  socketGeneration: number;
};

export type HelloMessage = {
  type: "hello";
  protocolVersion: 5;
  mapRevision: string | null;
  worldEpoch: number | null;
  sessionToken: string | null;
  socketGeneration: number;
};

export type PingMessage = {
  type: "ping";
  protocolVersion: 5;
  worldEpoch: number;
  nonce: number;
  sentAtMs: number;
};

export type PongMessage = {
  type: "pong";
  protocolVersion: 5;
  worldEpoch: number;
  nonce: number;
  sentAtMs: number;
  serverTick: number;
};

export type RtcOfferMessage = {
  type: "rtc-offer";
  protocolVersion: 5;
  worldEpoch: number;
  description: { type: "offer"; sdp: string };
  iceServers: Array<{ urls: string; username?: string; credential?: string }>;
};

export type RtcAnswerMessage = {
  type: "rtc-answer";
  protocolVersion: 5;
  worldEpoch: number;
  description: { type: "answer"; sdp: string };
};

export type SpeechVoice = 0 | 1 | 2 | 3 | 4;

export type SpeakMessage = {
  type: "speak";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number;
  text: string;
};

export type SpeechMessage = {
  type: "speech";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number;
  speakerId: RuntimeId;
  voice: SpeechVoice;
  text: string;
};

export type SpeechRejectedMessage = {
  type: "speech-rejected";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number;
  reason: "rate-limited" | "world-changed";
  retryAfterMs: number;
};

export type OwnershipRequestMessage = {
  type: "ownership-request";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number;
  target: RuntimeId;
  authorityVersion: number;
  holdDistance: number;
  relativeRotation: Quat;
};

export type OwnershipDeniedMessage = {
  type: "ownership-denied";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number;
  target: RuntimeId;
  reason: "stale" | "unavailable" | "out-of-range";
};

export type ManipulationRequestMessage = {
  type: "manipulation-request";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number;
  target: RuntimeId;
  authorityVersion: number;
  localAnchor: Vec3;
  holdDistance: number;
};

export type ManipulationDropMessage = {
  type: "manipulation-drop";
  protocolVersion: 5;
  worldEpoch: number;
  target: RuntimeId;
  authorityVersion: number;
  claimVersion: number;
};

export type ManipulationChangedMessage = {
  type: "manipulation-changed";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number | null;
  target: RuntimeId;
  authorityVersion: number;
  claimVersion: number;
  manipulatorPlayerId: RuntimeId | null;
};

export type ManipulationDeniedMessage = {
  type: "manipulation-denied";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number;
  target: RuntimeId;
  reason: "stale" | "unavailable" | "out-of-range" | "busy";
};

export type ManipulationStatePacket = {
  worldEpoch: number;
  target: RuntimeId;
  authorityVersion: number;
  claimVersion: number;
  stateSequence: number;
  targetPosition: Vec3;
  targetRotation: Quat;
};

export type UseRequestMessage = {
  type: "use-request";
  protocolVersion: 5;
  worldEpoch: number;
  requestId: number;
  target: RuntimeId;
};

export type ClientControlMessage =
  | HelloMessage
  | PingMessage
  | RtcAnswerMessage
  | SpeakMessage
  | OwnershipRequestMessage
  | ManipulationRequestMessage
  | ManipulationDropMessage
  | UseRequestMessage;
export type ServerControlMessage =
  | WelcomeMessage
  | PongMessage
  | RtcOfferMessage
  | SpeechMessage
  | SpeechRejectedMessage
  | OwnershipDeniedMessage
  | ManipulationChangedMessage
  | ManipulationDeniedMessage;

export type InputCommand = {
  type: "input";
  protocolVersion: 5;
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
