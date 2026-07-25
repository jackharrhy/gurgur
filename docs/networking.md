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

The browser samples intent on an absolute-deadline 60 Hz schedule. Early timer
wakes are re-armed rather than counted as samples, and delayed wakes skip obsolete
network sends instead of emitting a catch-up burst. Each datagram contains the
newest command plus up to two predecessors. Protocol v2's input-bundle header
also carries the latest received state tick and a selective 32-tick receipt mask.
This acknowledgement lets replication retire delivered terminal state; it never
makes state reliable or ordered. Redundancy recovers ordinary input loss without
retransmitting a stale intent:

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
during predicted-tick replay the proxy advances by that authoritative velocity.
This permits moving-platform and prop-support queries without creating a second
client-owned rigid-body history. The four nearest prop meshes may use
those current kinematic proxy poses so player and contact prop share one
presentation time. The proxy cannot receive local impulses or become gameplay
truth. Authoritative-velocity extrapolation advances for at most 100 ms from the
sample and then freezes. Reconciliation replay does not consume the separate
receipt-freshness clock: an awake dynamic proxy leaves prediction collision and
current-time contact presentation only after 100 ms of real client time without
another sample. A terminal-sleep sample instead remains as a stationary
collision proxy. Other prop meshes render from buffered authoritative tracks.

Input sequence and simulation time are deliberately separate. Each local
controller step records its predicted server tick, effective intent, and
resulting controller state. The predictor advances exactly once per predicted
server tick while holding the newest sampled intent. The client clock estimates
the current authoritative tick from timestamped state and ping observations.
Repeated intent callbacks targeting the same estimated tick only replace intent;
a callback can never mint another simulation step. Input sequence acknowledgement
remains transport and diagnostic metadata; packet arrival count and sequence
deltas never create or remove simulation steps.

On an authoritative player sample for tick `S` the predictor:

1. updates included moving-body collision proxies;
2. restores the authoritative controller state at `S`;
3. discards predicted history at or before `S`;
4. replays each recorded tick after `S` exactly once with its saved effective
   intent;
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

The per-client state packet targets at most 1,200 application bytes. Selection
is stateful per client rather than a stateless nearest-body sort:

- the local player and twelve nearest remotes have permanent slots, while three
  farther-player slots rotate when more than 16 players are connected;
- eight prop slots form an interaction lane for locally held, globally grabbed,
  and recently released bodies; release priority lasts 500 ms;
- nearby awake bodies accrue a delivery deadline of two snapshot intervals, and
  the four closest awake bodies retain contact priority;
- four slots cap terminal-sleep and discontinuity commits so transition churn
  cannot consume the packet;
- all other bodies accumulate unsent importance from age, distance, awake state,
  and linear/angular energy; debt clears only after the channel send succeeds;
- two slots remain available to accumulated farther state when mandatory near
  traffic leaves capacity.

Limiting remote-player records prevents players from consuming the whole packet
at 32 peers without starving distant-player presentation; a 16-player packet
still has room for roughly fourteen prop records. With fewer included players,
unused player bytes automatically become prop capacity. An awake or dirty body
outside every player's near region is globally staggered at 5 Hz. Per-client
state is coalesced to the newest body revision; there is no ordered delta
backlog. A terminal sleeping revision repeats in the bounded transition lane
until a selective state acknowledgement proves that revision arrived, then
becomes silent until it changes. The reliable connection snapshot seeds every
body, so sparse later samples never imply creation or deletion.

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

## Development traces

Appending `?debug` on a non-production server exposes a bounded Record/Stop
control for joined client/server network traces. The server capability and
capture routes return 404 whenever `NODE_ENV=production`; UI visibility is not
the security boundary.

A capture lasts at most 15 seconds and downloads one
`.gurgur-trace.json` document conforming to
[`gurgur-trace-v1.schema.json`](gurgur-trace-v1.schema.json). Format and embedded
analysis versions are independent integers. The document identifies build, map,
epoch, player, coordinate system, rates, limits, truncation, and stop reason.

The recorder preserves distinct semantic timelines instead of comparing two
unrelated wall-clock instants:

- side-effect-free post-step server authority is sampled at all 60 Hz simulation
  ticks without calling or mutating the replication snapshot builder;
- target-client outbound records retain send/drop status, selected
  pre-quantization state, decoded wire state, packet size, and backpressure;
- client snapshot records distinguish datagram receipt time from animation-frame
  processing time and retain whether a sample was the reconciliation frame's
  newest state;
- input records retain client sequence/tick, server receipt tick, redundant
  first-receipt status, transport, and validation result;
- prediction records retain fixed-step state before/after each input and the
  authority tick, acknowledgement, replay range, proxy freshness, raw error, and
  visible correction for each reconciliation;
- presentation records sample at no more than 60 Hz and retain estimated server
  tick, adaptive interpolation delay, presentation target tick, extrapolated
  identities, final body pose, and whether that pose came from buffered
  authority, current contact authority, prediction, or fallback.

Ticks and acknowledged input sequences are the primary joins. Client, prediction
worker, and server monotonic timestamps retain explicit time origins as
diagnostic metadata; wall-clock equality is never assumed. Embedded analysis
separates wire quantization, delivered-packet fidelity, raw prediction
corrections, presentation error by source, snapshot age, acknowledgement time,
replay depth, and worst samples. Predicted-local presentation error is explicitly
diagnostic because intentional client lead prevents it from being a determinism
assertion.

## Development MCP control plane

The non-production entrypoint starts an MCP Streamable HTTP endpoint at
`http://127.0.0.1:9237/mcp` by default. `GURGUR_DEV_MCP_PORT` changes the
loopback port and `GURGUR_DEV_MCP=0` disables it. The endpoint is a second
listener in the authoritative Bun process, never a route on the public game
listener. It rejects browser-originated requests and cannot be enabled when
`NODE_ENV=production`. The checked-in `.mcp.json` declares the default endpoint
for project-scoped clients such as Claude Code; those clients still require
workspace approval and a running development server.

Read tools expose the current map revision, epoch, tick, player poses, compiled
prop archetypes, authoritative prop state, and Box3D raycasts. Mutation tools
spawn and remove bounded ephemeral props and players. A controlled player still
enters the ordinary `GamePlayers.acceptInput` newest-wins path once per fixed
server tick; MCP cannot step physics or submit transforms as gameplay truth.
Movement calls have a maximum five-second duration and auto-stop. Runtime
creation/removal uses the normal generation-safe lifecycle broadcast, while all
MCP actors are omitted from SQLite and removed by world reset.

## Protocol and connection lifecycle

Protocol version 2 has exact bounded JSON control unions and explicit
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
epoch boundary. The browser keeps the next socket generation beside its
per-tab session token in `sessionStorage`, so a hard reload resumes with a
strictly newer generation instead of restarting at zero. A separately opened
tab receives a separate session unless the browser explicitly clones tab
storage.

## Gameplay transport

The same Bun process terminates HTTP/WebSocket and a `werift@0.23.0` WebRTC peer
per client. The server sends the offer and the browser returns the answer. This
ordering lets Firefox and Chromium begin checks against the server candidate.
Browser mDNS host candidates remain available for Werift to resolve on a shared
local network. When an answer contains mDNS candidates, its end-of-candidates
marker is withheld so slow or unavailable mDNS resolution cannot make Werift
prematurely fail an empty checklist; incoming checks can still establish the
peer-reflexive path, while server-reflexive and relay candidates remain intact.
The client creates `gurgur-input-v2` as unordered with no retransmissions. The
server creates `gurgur-state-v2` as unordered with at most one retransmission.
Creating a channel at its sender is mandatory: partial reliability is a sender
policy.

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
