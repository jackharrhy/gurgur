# Networking

## Authority and time

One Bun server owns the only gameplay-authoritative Box3D world. Clients send
sequenced intent, never transforms, collision outcomes, impulses, or successful
interaction results. The server validates intent, advances the shared world at a
fixed 60 Hz with four Box3D substeps, and publishes disposable views at 30 Hz.
Client time is diagnostic metadata and never advances server physics.

Each server tick is:

```text
select newest validated intent
  -> run pre-physics gameplay
  -> step Box3D once at 1/60 second
  -> collect contacts, sensors, movement, and sleep events
  -> run post-physics gameplay
  -> emit due replication and persistence work
```

Catch-up is capped at four ticks per host-loop turn. Excess accumulated time is
recorded and discarded rather than creating a latency spiral.

## Input

The browser samples at 60 Hz. Each datagram contains the newest command plus up
to two predecessors. Redundancy recovers ordinary loss without retransmitting a
stale intent:

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

The server range-checks decoded values, rejects stale epochs, and accepts only
strictly increasing sequences. It keeps one pending intent per player: a newer
command replaces an older unconsumed command. It never drains a delayed FIFO to
reenact obsolete movement. If no new intent arrives for 250 ms, held movement
axes clear. Monotonic action counters preserve jump/use/grab edges across loss
and redundant delivery without repeating them.

Interaction targets carry generation-bearing runtime identity. For grabs the
server uses that identity as a hint only and independently chooses the first body
on the authoritative view ray. For use interactions it validates the supplied
generation against its own ray. Distance, line of sight, ownership, and capability
remain authoritative in both cases.

## Physics-prop authority and prediction

All loose props, stacks, dominoes, constraints, grabs, sleep decisions, and
interaction outcomes are server authoritative. The client never presents a
locally simulated rigid-body result as truth.

The prediction worker predicts and replays only the local geometric player
controller. Authored moving geometry is present as a kinematic collision proxy.
An arriving authoritative prop sample replaces that proxy's pose and velocity;
during unacknowledged player replay the proxy advances by that authoritative
velocity. This permits moving-platform and prop-support queries without creating
a second client-owned rigid-body history. The four nearest prop meshes may use
those current kinematic proxy poses so player and contact prop share one
presentation time. The proxy cannot receive local impulses or become gameplay
truth. Authoritative-velocity extrapolation advances for at most 100 ms from the
sample and then freezes. Reconciliation replay does not consume the separate
receipt-freshness clock: an awake dynamic proxy leaves prediction collision and
current-time contact presentation only after 100 ms of real client time without
another sample. A terminal-sleep sample instead remains as a stationary
collision proxy. Other prop meshes render from buffered authoritative tracks.

On an authoritative player sample the predictor:

1. restores the acknowledged controller state;
2. updates included moving-body collision proxies;
3. drops acknowledged commands;
4. replays remaining commands at the fixed timestep;
5. records the correction as presentation-only state.

Corrections at or above 0.25 m and explicit discontinuities snap. Smaller offsets
decay over 100 ms through collision-clamped movement. Teleport, respawn,
`worldEpoch` change, and map reload clear prediction and interpolation state. A
state blackout longer than 500 ms is also a prediction discontinuity: the client
discards unacknowledged replay, expires awake prop proxies, and resumes from
authority. The shared controller rejects any non-finite or greater-than-one-metre
fixed-tick result on both server and client rather than presenting a Box3D
depenetration launch.

## Replication and interest

Snapshots are self-contained samples, not a reliable delta chain. The wire codec
uses a 15-byte header, 41-byte quantized rigid-body records, and 36-byte player
records. A player is serialized once; decoding reconstructs its render-body
sample. Position remains float32, quaternion components and velocities are
bounded int16 values, and flags mark create, teleport, wake, and sleep
discontinuities. Current-state flag bits also report global grab ownership and,
in each per-player view, whether that player owns the grab. These bits reuse the
existing body record and do not enlarge snapshots. A detected teleport marker
repeats for one second so losing the first disposable state packet cannot turn a
respawn into an enormous predicted correction.

The per-client state packet targets at most 1,200 application bytes:

- the local player and twelve nearest remotes have permanent slots, while three
  farther-player slots rotate when more than 16 players are connected;
- up to four nearest props receive permanent high-priority slots;
- the remaining near slots rotate across bodies within 12 m;
- two slots are reserved for rotating farther state when capacity is saturated;
- create, repeated teleport, wake, and repeated terminal-sleep samples take
  priority.

Limiting remote-player records prevents players from consuming the whole packet
at 32 peers without starving distant-player presentation; a 16-player packet
still has room for roughly fourteen prop records. With fewer included players,
unused player bytes automatically become prop capacity. An awake or dirty body
outside every player's near region is globally staggered at 5 Hz. A sleeping
body repeats its terminal state for one second, then becomes silent until it
changes. The reliable connection snapshot seeds every body, so sparse later
samples never imply creation or deletion.

This is presentation interest, not simulation culling. Every body continues in
the one 60 Hz server world.

## Interpolation

Snapshots are keyed by server tick. Each body owns an independently sorted track,
so reordered datagrams and sparse body selection cannot make a newer body state
discard an older sample for another body. Duplicate same-tick samples replace
their prior value.

The client clock estimator combines snapshot ticks with ping/pong RTT. Its render
delay adapts from 100 ms to 250 ms using measured jitter and missing-packet
pressure. Position is linear and orientation uses shortest-path quaternion
interpolation. When a moving track runs dry, velocity extrapolation is capped at
100 ms and then holds. Teleport and epoch discontinuities never interpolate.

The locally predicted player and four nearest authoritative-velocity contact
proxies render near predicted current time. Other props and remote players render
from buffered authoritative history.

## Protocol and connection lifecycle

Protocol version 1 has exact bounded JSON control unions and explicit
little-endian binary codecs. `mapRevision`, `worldEpoch`, runtime identity, and
protocol version remain separate:

- HTTP transfers the immutable, revision-addressed world bundle;
- WebSocket carries hello/welcome, world manifest, lifecycle, reset,
  ping/pong, WebRTC signaling, and the initial complete snapshot;
- WebRTC carries disposable input and current state datagrams.

World lifecycle records identify runtime actors only by source tag, runtime
index/generation, and immutable compiled `entityIndex`; players use the reserved
player sentinel. They never carry mapper classnames, authored IDs, strings, or
brush lists. Multiple harness-created bodies may intentionally share one compiled
entity index.

The browser may temporarily send binary input on WebSocket while WebRTC
negotiates. State never falls back to an ordered reliable stream; a peer that
cannot establish the gameplay state channel reconnects rather than accumulating
stale snapshots. Local input prediction arms only after the prediction world is
loaded and the first current WebRTC state sample has arrived, so negotiation
cannot create a prediction-only gap after the reliable initial snapshot.

Reconnect replaces the prior socket generation and rejects stale work. Ordinary
input, interpolation history, and prediction history never cross a reconnect or
epoch boundary.

## Gameplay transport

The same Bun process terminates HTTP/WebSocket and a `werift@0.23.0` WebRTC peer
per client. The server sends the offer and the browser returns the answer. This
ordering lets Firefox publish its mDNS-obfuscated host candidate after applying
the server offer; the server resolves that candidate before Werift starts its
eager ICE checks. The client creates `gurgur-input-v1` as unordered with no
retransmissions. The server creates `gurgur-state-v1` as unordered with at most
one retransmission. Creating a channel at its sender is mandatory: partial
reliability is a sender policy.

The server does not enqueue another state packet once the channel has two target
datagrams buffered. It drops that sample and continues with the next current
snapshot. Metrics expose connected state transports, buffered bytes, dropped
state packets, tick cost, acknowledgement latency, snapshot age, and whether any
current-time contact proxy continues moving beyond its 100 ms extrapolation cap.

Production binds a configured UDP range with `RTC_PORT_MIN` and `RTC_PORT_MAX`.
`RTC_ADDITIONAL_HOST_IPS` adds explicit bindable host candidates.
`RTC_ICE_SERVERS_JSON` supplies validated STUN/TURN configuration to both peers
for deployments that require server-reflexive or relay candidates. The server
sends this bounded configuration with the authenticated RTC offer; it is not
compiled into browser assets. Docker exposes UDP 40000-40100 by default in
addition to the HTTP port.
