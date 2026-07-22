# Networking

## Authority and time

The Bun server is authoritative. Clients send sequenced input and interaction
intent; the server validates those commands, advances one shared simulation, and
publishes authoritative state. The local player is predicted and reconciled.
Remote players and bodies render from snapshot history.

The server runs a fixed 60 Hz simulation with four Box3D substeps per tick.
Clients sample and send input at 60 Hz. The server publishes snapshots at 20 Hz.
Client time is metadata only and never determines server stepping or movement
duration.

Each server tick performs exactly this transaction:

```text
consume validated intent
  -> run pre-physics gameplay
  -> step Box3D once at 1/60 second
  -> collect contacts, sensors, movement, and sleep events
  -> run post-physics gameplay
  -> emit due replication and persistence work
```

Catch-up is capped at four ticks per host-loop turn. Additional accumulated time
is recorded as overload and discarded rather than creating an unbounded spiral.

## Input

The fixed-rate input codec contains:

```ts
type InputCommand = {
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
```

The server accepts finite, ranged values and strictly increasing sequences. It
keeps at most 120 pending commands per connection. It consumes FIFO during
ordinary delivery and coalesces a burst longer than twelve commands to its newest
intent, preventing a 60 Hz producer/consumer queue from accumulating permanent
latency. Held axes/buttons survive an ordered-transport stall for 750 ms and then
clear. One-shot actions use monotonic counters, so coalescing or a repeated packet
cannot lose or repeat an action edge.

Interaction commands use generation-bearing targets. The server validates target
existence, generation, distance, line of sight, rate, and authorization before it
creates constraints or changes mechanisms. Clients never submit collision
results, transforms, or successful outcomes.

## Prediction and reconciliation

The client prediction worker runs the same pinned Box3D Wasm, controller code,
coordinate conversion, constants, fixed timestep, and input codec as the server.
It predicts the local player only. Held and remote bodies remain authoritative
and use snapshot presentation; grab success is never predicted.

Every prediction tick stores the input command and replayable player state. An
authoritative player sample contains server tick, transform, linear velocity,
controller ground state, and last processed input sequence. On receipt, the
client restores that state, drops acknowledged commands, replays the remainder,
and stores any small correction as a render-only offset. Errors at or above
0.25 m and explicit discontinuities snap immediately; smaller visual offsets
decay over 100 ms.

Global puzzle results, remote bodies, ownership, and world interactions are never
predicted as truth. Teleport, respawn, `worldEpoch` change, and map reload clear
prediction and interpolation history.

## Remote interpolation

Snapshots are keyed by authoritative server tick, never packet-arrival time. The
client estimates server time from ping/pong samples and renders remote entities
150 ms behind it. Snapshot history retains 500 ms. At the 20 Hz snapshot rate,
this maintains:

```text
50 ms snapshot interval < 150 ms render delay < 500 ms history
```

Position uses linear interpolation and orientation uses shortest-path quaternion
interpolation. When history runs dry, velocity extrapolation is capped at 50 ms.
Spawn, teleport, wake discontinuity, and epoch changes snap. Sleeping bodies emit
one final state and remain silent until changed.

## Protocol

There is one discriminated client-packet union and one server-packet union in the
shared package. Every packet carries `protocolVersion`, message tag, and
`worldEpoch`; state packets also carry server tick. Connection and administrative
control messages use bounded JSON. Fixed-rate input, lifecycle, and snapshot
messages use explicit little-endian `DataView` codecs with a one-byte tag.

State samples are disposable and replaceable by a newer sample. Commands and
control events are reliable, bounded, epoch checked, and idempotent. Inputs,
snapshots, and predicted state are never replayed across reconnect. Static map
geometry is addressed by `mapRevision` and never replicated per tick.

After the welcome control message, the server sends one bounded world manifest
containing the immutable bundle URL, its `mapRevision`, and the runtime-handle
binding for each moving authored brush. The browser verifies and decodes the
binary bundle over HTTP, builds static Three.js geometry from it, and binds every
local-space convex child of a moving entity to its handle. Reset sends a new
manifest before the first snapshot of the new epoch; ordinary snapshots contain
transforms only.

## Gameplay transport

Gameplay uses Bun's native server WebSocket and the browser WebSocket API. It does
not use `ws`, geckos.io, WebTransport, application retransmission, or a generic
replication framework.

WebSocket is ordered and reliable. The server records send results, queued bytes,
backpressure duration, and pending-snapshot age. Clients and harnesses record RTT,
jitter, acknowledgement latency, interpolation use, and correction error. When
`ServerWebSocket.send` reports backpressure, the server stops producing snapshots
for that peer and retains only the newest unsent state. Immutable map bulk uses a
separately cacheable HTTP transfer. A connection whose queue makes no drain
progress for five seconds is closed.

Handshake requires an exact `protocolVersion`, `mapRevision`, authenticated
session identity, and current `worldEpoch`. Reconnect replaces the prior socket
generation and rejects all work from the stale socket. Reconnect backoff is
exponential with jitter and capped at ten seconds.

## Proximity voice

Voice uses a server-signaled WebRTC peer mesh carrying Opus audio tracks. It is a
separate media plane from gameplay WebSocket data. The game server authenticates
signaling and computes audible membership from authoritative positions.

The server maintains a symmetric audible graph with degree at most six,
prioritizing the nearest permitted pairs. A peer pair enters the graph at 20 m
and leaves beyond 24 m, providing boundary hysteresis.
Client-side Web Audio spatialization is full gain through 3 m and reaches zero at
20 m. These distances and the six-peer cap are server configuration, applied
consistently to every client.

Production voice includes STUN and TURN. Relay-only mode is available when peer
network addresses must remain private. Signaling carries session identity and
`worldEpoch`; leaving range, reset, logout, or block tears down the corresponding
media connection. Local mute changes gain only. Blocking revokes signaling and
media access on the server. Microphone access begins only after explicit user
action, and denial or device loss leaves gameplay unaffected.
