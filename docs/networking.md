# Networking

## Selected model

Protocol v7 uses Source-style bounded prediction over Bun-authoritative gameplay.
Bun owns every player and shared rigid body. A browser predicts its local
player, a confirmed loose held prop, and the checkpoint-selected nearby loose
contact island. Prediction uses the same `stepPlayerController`, `stepPropGrab`,
Box3D adapter, 60 Hz tick, and four substeps as Bun. It is restored from
authoritative checkpoints and replays commands that Bun has not acknowledged.

This is not deterministic full-world lockstep. Joint-connected contraptions,
mechanisms, other players, and loose bodies outside the bounded local set remain
Bun-only dynamic simulation. Browser copies of those objects are non-simulating
collision proxies.

The model follows Source SDK 2013's separation between authoritative server
movement, shared predicted movement code, command acknowledgement, restore, and
replay. S&box remains useful for explicit object identity, proxy state,
authority versions, and fixed-authority control joints; it is not the selected
player-authority model. The detailed comparison is in
[`networked-physics-deep-dive.md`](networked-physics-deep-dive.md).

## Authority registry

Every runtime descriptor contains nullable `ownerPlayerId`, `authorityVersion`,
and transfer policy `fixed`. In protocol v7 every gameplay descriptor has
`ownerPlayerId: null`: Bun is authority.

| Object                           | Dynamic authority | Browser treatment                      |
| -------------------------------- | ----------------- | -------------------------------------- |
| Local network player             | Bun               | predicted and reconciled               |
| Remote network player            | Bun               | source-timed proxy and buffered render |
| Confirmed held loose prop        | Bun               | predicted dynamic body, reconciled     |
| Selected nearby loose prop       | Bun               | predicted dynamic body, reconciled     |
| Other unheld loose prop          | Bun               | newest-state kinematic collision proxy |
| Jointed body or mechanism        | Bun               | proxy only; no graph prediction        |
| Trigger, mover, diagnostic actor | Bun               | replicated capability/proxy            |

Collision never transfers authority. A browser cannot publish player or body
truth. Claims reserve an interaction; they do not change object authority or
body ownership.

## Fixed simulation and commands

Bun and the browser physics worker advance at exactly 60 Hz with four Box3D
substeps. Render time, packet arrival time, and a remote clock never determine a
physics step.

The browser worker samples the latest input intent at each fixed tick, assigns a
monotonic sequence and client tick, predicts the command, and sends an
`InputBundlePacket` over the unordered disposable channel. A bundle contains the
current command plus up to the previous three commands, oldest to newest. This
redundancy makes isolated loss recoverable without putting current input behind
an ordered reliable queue.

Bun keeps a bounded 128-command arrival queue per player. It deduplicates by
sequence and rejects stale epochs, invalid values, oversized bundles, and
implausibly future sequences. On each server tick it drains the arrivals,
advances movement once from the newest valid intent, and recovers a bounded
number of action-counter edges from older samples. A late burst therefore
cannot become a permanent movement backlog. If no command arrives, continuous
intent may repeat without retriggering actions; after the intent timeout,
movement returns to zero.

## Checkpoints, restore, and replay

At 30 Hz Bun sends each browser an owner-specific
`PredictionCheckpointPacket` containing:

- `worldEpoch` and authoritative server tick;
- last processed input sequence;
- complete local-player physics/controller state;
- exact states for a stable set of at most four eligible loose bodies within
  six metres; the player's support and the held prop's live contact graph take
  priority, retained members fill the next slots, and distance breaks ties;
- optional complete held-body state;
- held claim version and grab seed: target, start input sequence, centre local
  anchor, distance, relative rotation, target position/rotation, and tracking
  error.

The checkpoint object and world-state batch are captured inside the same fixed
tick. Delta encoding, packet construction, and data-channel writes run after the
simulation step from that immutable batch, so network I/O does not consume the
Box3D tick budget or change the checkpoint's source tick.

The browser retains 128 prediction records. On a checkpoint it:

1. discards acknowledged records;
2. restores the authoritative player, optional held body, and bounded nearby
   loose-body set as dynamic bodies;
3. restores every other proxy from source-tick history at the checkpoint tick;
4. replays every unacknowledged command through the shared controllers and
   Box3D step;
5. keeps only the checkpoint-selected loose set dynamic and returns every other
   body to its newest accepted authoritative proxy state.

Physics correction is immediate. Rendering keeps continuity with an additive
visual error offset that decays over 100 ms without suppressing new predicted
motion. Player corrections over one metre ordinarily hard-snap. Predicted-body
corrections and transitions out of the bounded set remain rate-bounded. Epoch,
map, respawn, and lifecycle discontinuities replace history.

## Collision and presentation timelines

Browser physics never uses the old fixed eight-tick collision delay. An ordinary
body proxy retains source-tick history but normally targets the newest accepted
authoritative transform. During checkpoint replay it samples that history at
the replayed server tick. The local player, confirmed held prop, and at most four
checkpoint-selected nearby loose bodies use their predicted physics bodies.

Rendering remains a separate consumer:

- local predicted state renders from the newest completed worker step;
- ordinary remote tracks adapt independently between four and eight source
  ticks and never extrapolate beyond their newest sample;
- a rigid body within 2 m of the local player, currently touching/supporting it,
  or interacting with the predicted held prop uses the collision-aligned pose;
- entry/exit blends over 100 ms, relevance is retained for 500 ms, and distance
  exit uses a 2.5 m hysteresis radius;
- remote players retain buffered presentation rather than being forced onto a
  banded 30 Hz collision pose;
- a held loose prop always renders from its predicted Box3D body, never directly
  from a grab target.

The browser exposes a bounded diagnostic trace containing input sequence,
server tick, acknowledgement, replay count, contact/support IDs, and
authoritative, collision, predicted, and rendered transforms.

On development servers, `?debug` can pair that browser trace with a 15-second,
900-tick Bun capture for the local player. Bun records its consumed/queued input,
authoritative player and nearby-body states, contact edges/hits, and support ray
for each fixed tick. The browser downloads both halves as one JSON artifact.
`/debug/network-trace` is a development-only HTTP diagnostic surface: it is not
protocol v7, is never consumed by gameplay, and is unavailable in production.

## Protocol v7

Reliable WebSocket traffic carries hello/welcome, WebRTC signaling, world
manifest and binary bootstrap, lifecycle, reliable discontinuities, contraption
manipulation request/grant/denial/drop, use, reset, speech, and ping/pong.

Disposable unordered WebRTC uses:

- `gurgur-input-v7`: four-command input bundles, state acknowledgements, and
  fixed-size manipulation targets for explicitly manipulable contraptions;
- `gurgur-state-v7`: acknowledged state clusters and prediction checkpoints.

The removed v6 `OwnedStatePacket` and `OwnerCommitPacket` have no v7 codec or
server acceptance path. Protocol v7 is intentionally incompatible with v6.
Persisted world data is unchanged.

Ordinary state publishes at 30 Hz. A held or directly manipulated body is a
60 Hz hot state and remains hot for 500 ms after release so a fast physical
release cannot immediately fall onto a banded 30 Hz presentation. Current-state clusters remain at most 1,200 bytes, coalesce
obsolete pending values, use per-recipient acknowledged delta baselines, resend
unacknowledged state after 250 ms, and drop under backpressure instead of
building a reliable queue. There is no spatial interest management yet.

`authorityVersion`, uint16 `stateSequence`, uint32 `sourceTick`, command
sequence, claim version, `worldEpoch`, `mapRevision`, and persistence version
are independent.

## Loose pickup and contraption manipulation

For a loose `grab`, primary is a command edge. Bun raycasts from its authoritative
player pose and view, applies first-wins contention, derives the target and
bounded grab controller locally, and includes the confirmed body/grab seed in
checkpoints. The browser begins held-body prediction only after that
confirmation. Both simulations run `stepPropGrab`; no browser target packet or
body state is accepted for a loose prop. Once confirmed, a later primary edge
is itself predicted and replayed, so the client stops advancing the held body at
the same command where Bun will release it rather than simulating unacknowledged
post-release commands as if the grab still existed.

Joint-connected or explicitly `manipulate` bodies stay server-only. The browser
may request an exclusive claim and send a disposable target for a body-local hit
anchor. Bun applies that target through a private native control joint so the
whole joint graph and every shared contact remain in one solver. Release,
timeout, disconnect, reset, or lifecycle removal destroys the temporary
constraint without changing body authority.

## Validation and recovery

Input and state codecs enforce finite bounded fields and object counts. Input,
acknowledgement, and manipulation datagrams have independent rate limits.
Duplicate commands are harmless; action counters execute once. Stale epochs,
authority versions, state sequences, and claim versions are rejected.

On transport loss Bun releases the player's grab and contraption claims. Session
grace may retain identity, but Bun continues to own the player. Reconnect or
reset increments player `authorityVersion`, clears command/replay history, and
sends a complete reliable state. Falling through the void respawns on Bun and
arrives as an authoritative discontinuity.

Spawning, deletion, persistence, mechanisms, session identity, use validation,
claims, and reset remain host coordinated. Protocol v7 no longer trusts a
browser transform as cooperative gameplay truth.
