# Initial Quake-Style Networking Reference

> Archived source note. The canonical networking design is
> [`docs/networking.md`](../networking.md). It corrects the relationship between
> client input duration and the fixed timestep of one shared Box3D world.

## Primary Reference

Use the networking and ECS architecture in:

`https://github.com/jackharrhy/burger`

This project should not merely use generic transform snapshots. It should follow the broad Quake-style model demonstrated by `burger`:

* The client sends sequenced input commands.
* The server simulates those commands authoritatively.
* The client predicts its own movement immediately.
* The server acknowledges the last processed input sequence.
* The client reconciles against authoritative state.
* The client replays all still-unacknowledged inputs.
* Remote entities are interpolated from buffered snapshots.
* Client and server share simulation code wherever practical.

Do not copy `burger` blindly. Adapt its model from a simple two-dimensional game into a persistent Three.js and Box3D world.

## Package Structure

```text
packages/
├── game-shared/
│   ├── components.ts
│   ├── queries.ts
│   ├── protocol.ts
│   ├── simulation.ts
│   ├── movement.ts
│   ├── interactions.ts
│   └── constants.ts
│
├── game-server/
│   ├── server.ts
│   ├── world.ts
│   ├── network.ts
│   ├── persistence.ts
│   └── admin.ts
│
├── game-client/
│   ├── game.ts
│   ├── network.ts
│   ├── prediction.ts
│   ├── interpolation.ts
│   └── renderer.ts
│
├── map-format/
├── entity-schema/
└── world-compiler/
```

`game-shared` must be usable in both browser and Bun environments.

It should contain deterministic gameplay logic, ECS component definitions, protocol types, input application, and movement rules.

It must not import:

* Three.js
* DOM APIs
* Bun APIs
* SQLite
* Server WebSocket types
* Rendering code

## Shared ECS

Use BitECS, following `burger`.

The authoritative server and browser client each maintain their own ECS world.

Suggested components:

```ts
export const Transform = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
  qx: new Float32Array(MAX_ENTITIES),
  qy: new Float32Array(MAX_ENTITIES),
  qz: new Float32Array(MAX_ENTITIES),
  qw: new Float32Array(MAX_ENTITIES),
};

export const LinearVelocity = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};

export const AngularVelocity = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};

export const Player = {
  clientId: new Uint32Array(MAX_ENTITIES),
  lastProcessedInput: new Uint32Array(MAX_ENTITIES),
};

export const PhysicsBody = {
  bodyId: new Uint32Array(MAX_ENTITIES),
  bodyType: new Uint8Array(MAX_ENTITIES),
};

export const MapEntity = {
  sourceId: new Uint32Array(MAX_ENTITIES),
};

export const Networked = {};
export const Predictable = {};
export const Interpolated = {};
export const Persistent = {};
export const AdminOnly = {};
```

Keep Box3D body objects outside ECS component arrays.

Use an explicit mapping:

```ts
type PhysicsRegistry = {
  entityToBody: Map<number, Box3DBody>;
  bodyToEntity: Map<Box3DBody, number>;
};
```

The ECS stores game state and stable identity.

Box3D performs physics.

Three.js performs rendering.

## Shared Input Commands

Follow `burger` by sending input commands rather than client positions.

```ts
export type InputCommand = {
  sequence: number;
  msec: number;

  moveX: number;
  moveZ: number;

  lookYaw: number;
  lookPitch: number;

  jump: boolean;
  interact: boolean;
  primary: boolean;
  secondary: boolean;
};
```

`msec` is the amount of real time represented by the command.

The server must clamp it:

```ts
export const MAX_INPUT_MSEC = 50;

export function clampInputMsec(msec: number): number {
  return Math.max(1, Math.min(MAX_INPUT_MSEC, msec));
}
```

Never trust client position, velocity, body transforms, interaction results, or collision results.

## Shared Simulation Functions

The client and server should use the same functions for player movement:

```ts
export function applyPlayerInput(
  world: GameWorld,
  eid: number,
  command: InputCommand,
): void {
  const dt = clampInputMsec(command.msec) / 1000;

  updateViewAngles(world, eid, command);
  applyMovementIntent(world, eid, command, dt);
  applyJumpIntent(world, eid, command);
}
```

The server uses this before stepping its authoritative Box3D world.

The client uses it for prediction against its local prediction world.

Avoid separate client and server movement implementations.

The shared function should express intent and manipulate the physics body through a small environment-independent adapter:

```ts
export interface CharacterPhysics {
  getPosition(eid: number): Vec3;
  getVelocity(eid: number): Vec3;

  setVelocity(eid: number, velocity: Vec3): void;
  applyImpulse(eid: number, impulse: Vec3): void;

  isGrounded(eid: number): boolean;
}
```

Both client and server can provide a Box3D-backed implementation.

## Fixed Server Tick

Run one authoritative world at a fixed rate:

```ts
export const SERVER_TICK_RATE = 60;
export const SNAPSHOT_RATE = 20;
export const SERVER_DT = 1 / SERVER_TICK_RATE;
```

Each server tick:

```ts
function serverTick(): void {
  receiveQueuedCommands();
  processPlayerInputs();

  runPrePhysicsSystems();
  box3dWorld.step(SERVER_DT);
  runPostPhysicsSystems();

  copyPhysicsStateIntoEcs();
  recordPersistentChanges();

  if (tick % SNAPSHOT_INTERVAL === 0) {
    broadcastSnapshots();
  }

  tick++;
}
```

Use an accumulator rather than assuming timers fire exactly on time:

```ts
let previousTime = performance.now();
let accumulator = 0;

function loop(): void {
  const now = performance.now();
  accumulator += Math.min((now - previousTime) / 1000, 0.25);
  previousTime = now;

  while (accumulator >= SERVER_DT) {
    serverTick();
    accumulator -= SERVER_DT;
  }
}
```

## Server Input Queues

Maintain per-client connection state similar to `burger`:

```ts
export type ClientConnection = {
  playerEid: number;

  inputQueue: InputCommand[];

  lastReceivedSequence: number;
  lastProcessedSequence: number;

  isAdmin: boolean;
};
```

Validate monotonically increasing sequence numbers:

```ts
function enqueueInput(
  connection: ClientConnection,
  command: InputCommand,
): void {
  if (command.sequence <= connection.lastReceivedSequence) {
    return;
  }

  connection.lastReceivedSequence = command.sequence;
  connection.inputQueue.push(command);

  while (connection.inputQueue.length > MAX_QUEUED_INPUTS) {
    connection.inputQueue.shift();
  }
}
```

Process a bounded number per server tick:

```ts
function processInputs(connection: ClientConnection): void {
  const commands = connection.inputQueue.splice(
    0,
    MAX_INPUTS_PER_SERVER_TICK,
  );

  for (const command of commands) {
    applyPlayerInput(world, connection.playerEid, command);
    connection.lastProcessedSequence = command.sequence;
  }
}
```

This protects the server from clients flooding it with accumulated commands.

## Client Prediction

The local client applies input immediately.

```ts
function createAndSendInput(frameMsec: number): void {
  const command: InputCommand = {
    sequence: ++network.inputSequence,
    msec: frameMsec,

    moveX: input.moveX,
    moveZ: input.moveZ,

    lookYaw: input.lookYaw,
    lookPitch: input.lookPitch,

    jump: input.jump,
    interact: input.interact,
    primary: input.primary,
    secondary: input.secondary,
  };

  network.pendingInputs.push(command);

  applyPlayerInput(
    predictionWorld,
    localPlayerEid,
    command,
  );

  socket.send(encodeInput(command));
}
```

The client should predict:

* Its own movement
* Camera movement
* Immediate interaction animations
* Potentially the object currently held by the player

The client should not authoritatively predict:

* Puzzle completion
* Button activation by another player
* Ownership changes
* Arbitrary world-object collisions
* Global reset
* Other players

## Reconciliation

Every authoritative player snapshot includes:

```ts
export type LocalPlayerSnapshot = {
  tick: number;
  entityId: number;

  position: Vec3;
  rotation: Quat;

  linearVelocity: Vec3;
  angularVelocity: Vec3;

  grounded: boolean;

  lastProcessedInputSequence: number;
};
```

When it arrives:

```ts
function reconcile(snapshot: LocalPlayerSnapshot): void {
  const before = getPredictedTransform(localPlayerEid);

  setAuthoritativePlayerState(localPlayerEid, snapshot);

  network.pendingInputs = network.pendingInputs.filter(
    (command) =>
      command.sequence > snapshot.lastProcessedInputSequence,
  );

  for (const command of network.pendingInputs) {
    applyPlayerInput(
      predictionWorld,
      localPlayerEid,
      command,
    );

    stepPredictionWorld(command.msec / 1000);
  }

  const after = getPredictedTransform(localPlayerEid);

  predictionError.position.x += before.position.x - after.position.x;
  predictionError.position.y += before.position.y - after.position.y;
  predictionError.position.z += before.position.z - after.position.z;
}
```

Do not always snap the rendered player or camera.

Maintain a correction offset and decay it:

```ts
function smoothPredictionError(dt: number): void {
  const rate = 12;
  const factor = Math.exp(-rate * dt);

  predictionError.position.x *= factor;
  predictionError.position.y *= factor;
  predictionError.position.z *= factor;
}
```

The rendered transform is:

```ts
renderPosition =
  predictedPosition + predictionError.position;
```

Large errors should snap:

```ts
if (distance(authoritative, predicted) > TELEPORT_THRESHOLD) {
  clearPredictionError();
  snapToAuthoritativeState();
}
```

## Remote Entity Interpolation

Do not render remote players directly at their newest received transform.

Store a short history:

```ts
export type TransformSample = {
  serverTime: number;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
};

const histories = new Map<number, TransformSample[]>();
```

Render in the recent past:

```ts
export const INTERPOLATION_DELAY_MS = 100;

const renderTime =
  estimatedServerTime - INTERPOLATION_DELAY_MS;
```

Find two samples surrounding `renderTime` and interpolate:

```ts
const alpha =
  (renderTime - older.serverTime) /
  (newer.serverTime - older.serverTime);

position = lerpVec3(
  older.position,
  newer.position,
  alpha,
);

rotation = slerpQuat(
  older.rotation,
  newer.rotation,
  alpha,
);
```

Allow brief velocity-based extrapolation when the history runs dry, but cap it aggressively.

Dynamic physics objects should generally use this same interpolation path.

## Network Message Classes

Use one-byte binary message tags as in `burger`.

```ts
export const MessageType = {
  Hello: 1,
  WorldSnapshot: 2,
  EntityCreate: 3,
  EntityDestroy: 4,
  ComponentDelta: 5,
  Input: 6,
  PlayerState: 7,
  PhysicsSnapshot: 8,
  Interaction: 9,
  WorldReset: 10,
  Ping: 11,
  Pong: 12,
} as const;
```

Use JSON during the earliest implementation only where convenient.

The protocol should quickly move toward:

```text
[1-byte message type][binary payload]
```

Do not introduce Protobuf, FlatBuffers, or a custom bit-packing DSL initially.

A small `DataView` encoder and decoder is sufficient.

## Initial Snapshot and Entity Deltas

Follow the useful split in `burger`:

### Initial world snapshot

Sent once after connection:

* Protocol version
* World revision
* Server tick
* Server time
* Local player entity ID
* All currently relevant networked entities
* Their networked components
* Static compiled-world revision

### Entity structural messages

Sent when entities appear or disappear:

```ts
type EntityCreateMessage = {
  entityId: number;
  generation: number;
  componentMask: number;
};

type EntityDestroyMessage = {
  entityId: number;
  generation: number;
};
```

### Component state messages

Sent when component data changes:

```ts
type ComponentDeltaMessage = {
  tick: number;
  entities: NetworkEntityDelta[];
};
```

Unlike the current `burger` implementation, this project should implement entity generations from the beginning.

An entity identity is:

```ts
export type NetworkEntityId = {
  index: number;
  generation: number;
};
```

This prevents a delayed packet concerning a destroyed entity from mutating a newly created entity that reused the same ECS index.

## Physics Snapshots

Do not send the complete Box3D world.

Send only networked dynamic bodies:

```ts
export type PhysicsBodySnapshot = {
  entityId: number;
  generation: number;

  position: Vec3;
  rotation: Quat;

  linearVelocity: Vec3;
  angularVelocity: Vec3;

  sleeping: boolean;
};
```

Static TrenchBroom geometry is already available from the compiled world bundle and is never replicated as per-tick state.

Sleeping bodies should not be resent until they wake or their state changes.

## Relevance Filtering

The product is conceptually one world, but that does not require broadcasting every dynamic object to every browser.

Keep one server and one authoritative Box3D world while filtering network updates by relevance:

```ts
function isRelevant(
  observerPosition: Vec3,
  entityPosition: Vec3,
): boolean {
  return squaredDistance(observerPosition, entityPosition)
    <= NETWORK_RELEVANCE_RADIUS_SQUARED;
}
```

The first implementation can send everything.

Add spatial relevance only after profiling demonstrates the need.

Do not split the world into server zones or separate simulations.

## Player Interaction With Physics Objects

Interaction messages describe intent:

```ts
export type InteractionCommand = {
  sequence: number;
  targetEntityId: number;
  action: "use" | "grab" | "release";
  clientTick: number;
};
```

The server validates:

* Target exists
* Target generation matches
* Player is close enough
* Line of sight is valid where applicable
* Object is interactable
* Player is allowed to perform the action

For grabbing:

* The server creates the authoritative constraint.
* The local client may create a predicted visual constraint.
* Authoritative snapshots correct the object.
* Other clients interpolate it.

Do not accept object transforms from clients.

## Persistence Is Separate From Replication

SQLite persistence must not be part of the real-time network loop.

The authoritative in-memory ECS and Box3D world are the live truth.

SQLite receives periodic snapshots of persistent entities:

```ts
type PersistedPhysicsState = {
  mapEntityId: string;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  sleeping: boolean;
  customState: Uint8Array | null;
};
```

Network entity IDs are runtime-only.

Persistent map entities use stable IDs generated by the map compiler.

## World Reset

A reset is a protocol-level world revision change.

```ts
type WorldResetMessage = {
  worldRevision: number;
  serverTick: number;
};
```

On reset:

1. Stop accepting gameplay input.
2. Increment the world revision.
3. Destroy the existing ECS and Box3D world.
4. Reload the compiled TrenchBroom world.
5. Clear persisted runtime state.
6. Respawn connected players.
7. Send every client a new full snapshot.
8. Clear every client’s prediction and interpolation buffers.
9. Resume input processing.

Clients must discard all packets from an older world revision.

Every state packet should therefore contain:

```ts
worldRevision: number;
```

## Protocol Versioning

The initial welcome message contains:

```ts
type WelcomeMessage = {
  protocolVersion: number;
  worldRevision: number;
  playerEntityId: number;
  serverTick: number;
  serverTime: number;
};
```

Disconnect immediately when the protocol version is incompatible.

Do not attempt backward compatibility during early development.

## Differences From Burger

Retain from `burger`:

* Shared BitECS components
* Shared client/server simulation functions
* Sequenced input commands
* `msec` per input
* Server input queues
* Server acknowledgements
* Prediction
* Reconciliation
* Replay of pending inputs
* Remote interpolation
* Binary message tags
* Initial snapshot plus entity/component deltas

Improve or change:

* Use raw `ws` rather than Elysia WebSocket wrappers.
* Use Three.js rather than Pixi.
* Use Box3D rather than custom tile collision.
* Include entity generations immediately.
* Include world revision in state packets.
* Replicate dynamic physics bodies.
* Separate static map geometry from runtime entity replication.
* Introduce optional relevance filtering later.
* Keep one authoritative persistent world.
* Avoid accounts and OAuth in the first milestone.
* Avoid editing, zone, tile-catalog, and paint systems from `burger`.

## Agent Instructions

Before implementing networking, inspect these files in `burger`:

```text
packages/burger-shared/src/ecs.shared.ts
packages/burger-shared/src/types.shared.ts
packages/burger-shared/src/world.shared.ts

packages/burger-server/src/network.server.ts
packages/burger-server/src/server.ts
packages/burger-server/src/world.ts
packages/burger-server/src/input-validation.ts

packages/burger-client/src/game/network.ts
packages/burger-client/src/game/index.ts
packages/burger-client/src/game/consts.ts
```

Use them as architectural prior art.

Do not mechanically copy their game-specific code.

The implementation order should be:

1. Shared ECS components
2. Shared protocol and input command types
3. Shared player movement function
4. Fixed authoritative server tick
5. WebSocket input queue
6. Initial full snapshot
7. Remote player interpolation
8. Local player prediction
9. Input acknowledgements
10. Reconciliation and replay
11. Dynamic Box3D-body snapshots
12. Entity creation and destruction
13. Entity generations
14. SQLite persistence
15. Administrative world reset

The first networking test must run two browser clients against one Bun server and verify:

* Both clients see both players.
* Local movement responds immediately.
* Remote movement interpolates smoothly.
* Artificial latency does not prevent movement.
* Client prediction is corrected by the server.
* Inputs are acknowledged and removed from the pending buffer.
* Disconnecting removes the player entity.
* Reconnecting creates a new generation-safe identity.
