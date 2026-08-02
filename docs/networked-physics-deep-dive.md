# Networked physics: evidence, target model, and proof

This is the evidence and migration guide behind
[decisions 0022](decisions/0022-centralized-shared-rigidbody-physics.md) and
[0024](decisions/0024-source-style-networked-physics.md). Selected
behavior lives in [networking](networking.md), [physics](physics.md),
[architecture](architecture.md), and [testing](testing.md). Historical
"current Gurgur" comparisons below describe the protocol-v5 baseline that the
decision replaced. Active sequencing belongs only in
[the work tracker](work.md). The follow-up
[client-feel research](networked-physics-client-feel.md) records why protocol
v6's owner-facing presentation was rejected.

Research baseline: 2026-07-31. The local references were
[s&box public `2053455`](https://github.com/Facepunch/sbox-public/tree/2053455813f24165d614cdeaf561082eecc86990)
(the revision pinned by decision 0019; the relevant files are unchanged at local
HEAD `1a22bc7`) and
[Source SDK 2013 `88fa198`](https://github.com/ValveSoftware/source-sdk-2013/tree/88fa198fba3fb85d46d4c95018254693fdc3af0a).

## 2026-08-02 implementation outcome

The conditional Source-style route described later in this guide is now the
selected protocol-v7 architecture. The direct comparison that forced the change
was:

| Version                     | Player / prop behavior                                                                                        | Observed result                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Clean `main` at `d604849`   | Browser simulates its player and held loose prop together with real Box3D                                     | Best local feel, but split gameplay authority and delayed remote state            |
| Protocol-v6 overlay         | Browser owns player, Bun owns props, collision proxies stay eight ticks old, mesh follows target in one frame | Pickup snap and visible/collision/authority disagreement while walking over props |
| Protocol v7 + decision 0025 | Bun authority; browser replays the player, held body, and bounded nearby loose-body contact island            | Responsive local contacts with explicit correction and one gameplay truth         |

Protocol v6 correctly centralized shared rigid bodies, but its feel layer made a
false physical claim. `SpeculativeHeldPresenter` moved a mesh to the desired
target within one frame. Browser collision remained approximately eight ticks
old, ordinary rendering was roughly four to eight ticks old, and Bun used a
different delayed player proxy. The player could therefore see, collide with,
and authoritatively affect three different prop poses.

The tests encoded the wrong oracle. A unit test required the prop to reach its
target within one 60 Hz interval, the browser gate treated any movement over
5 cm within 50 ms as success, release allowed a 50 cm frame discontinuity, and
no scenario walked onto a moving body while comparing the four timelines.
Protocol v7 replaces those assertions with shared-simulation conformance,
bounded acceleration, walk/stand/cross contacts, replay/ack correctness, visual
decay, and production-browser behavior gates.

The first paired `?debug` captures then found three narrower implementation
mistakes. A capture-induced producer stall left Bun permanently 15–16 commands
behind because the server treated sampled input as movement work. The held body
hit two dynamic props at about 8.5 m/s on Bun while browser replay represented
those props as kinematic. Finally, predicted held poses reused the last host
state sequence, causing the renderer to discard valid local steps. Decision
0025 responds directly: newest-intent burst recovery, off-main-thread capture
assembly, per-tick local presentation sequences, and a checkpoint-selected
four-body nearby contact island.

This outcome does not invalidate the s&box, Source, or Gaffer analysis below. It
changes which lessons are decisive. S&box remains the reference for explicit
identity, proxy state, authority generations, disposable replication, and
native control joints. Source's authoritative movement, shared prediction code,
checkpoint restore, command replay, and local physcannon simulation now define
the player/held-prop model. Gurgur additionally predicts a bounded nearby loose
contact island because its geometric player controller exchanges explicit
reaction impulses with loose bodies. `arctic-char` provides the concrete historical-proxy
sampling pattern used during replay. Gaffer's work defines the fixed-step and
presentation-time constraints. Box3D remains because the diagnosed failure was
not a solver failure and the same adapter passes the Bun/browser trace.

## Historical protocol-v5/v6 conclusion

The following conclusion explains decision 0022's first centralized-body step.
Where it defers Source-style player prediction, decision 0024 and the outcome
above supersede it.

Gurgur has a respectable protocol skeleton. Its reliable authority epochs,
per-object state sequences, acknowledged delta baselines, 1,200-byte disposable
clusters, and stale-authority rejection are close to the corresponding s&box
machinery. Those are not the main risk.

The two highest-risk gaps are:

1. **There is no shared simulation timeline in disposable state.** A state has
   an authority version and sequence, but not the physics tick at which it was
   produced. Presentation timestamps samples when packets arrive. Network jitter
   is therefore converted directly into changes of apparent speed.
2. **A collision can straddle two solvers.** A browser can dynamically simulate
   its held prop while Bun dynamically simulates a body that prop hits. Each
   solver sees the other object as a delayed kinematic proxy. There is no single
   contact solve that applies one equal-and-opposite impulse to both authoritative
   states.

Copying more of s&box does not by itself close either gap. s&box adds several
important details that Gurgur does not yet have, especially physics-aware proxy
movement, sleep-aware velocity replication, visibility, and a forced reliable
pre-handoff snapshot. But its generic transform interpolation is also based on
local receipt time, and its public tests do not prove perceptual or conservation
quality under a real impaired network.

The recommended end state under Gurgur's current no-prediction product contract
is:

- browsers remain authoritative for their geometric player controller;
- players are explicitly treated as kinematic gameplay actors, not reciprocal
  rigid bodies;
- **Bun is the sole authority for every shared dynamic rigid body**, including a
  loose prop while it is held;
- grabbing sends the latest disposable target/intent to Bun, which drives the
  body with the native control joint already used for fixed contraptions;
- every replicated sample carries a source physics tick mapped to a common host
  timeline;
- rendering and collision proxies sample that timeline, with bounded
  interpolation and no rigid-body extrapolation;
- visual smoothing is separate from simulation state.

This is closer to Source's authority over ordinary shared props than to
generalized s&box object ownership. It deliberately gives up authoritative,
latency-free held-body world motion in exchange for one solver owning every
shared contact. The original recommendation stopped at immediate hand, beam,
reticle, and control-target feedback. The later client-feel investigation found
that insufficient for a manipulation-heavy game: Source's multiplayer
physcannon also constructs a confirmed local VPhysics view of the held object.
A similarly narrow speculative presentation is compatible with Bun authority as
long as it cannot affect gameplay state and reconciles to Bun checkpoints.

If the product later requires a shared rigid body to push the local player back,
or requires authoritative vehicles and reciprocal player/body contacts, the
current player-ownership contract is no longer sufficient. The robust route is
then Source-style server authority plus tick-numbered inputs, client-side player
prediction, authoritative checkpoints, rewind/replay, and visual error
smoothing. That is a conscious product and architecture change; it is not an
incremental flag on protocol v5.

Replacing Box3D cannot repair an authority or time-model error. Box3D should,
however, be treated as replaceable until it passes a browser/server conformance
suite: the project is pinned to upstream v0.1.0, whose author explicitly calls
the release alpha software. Rapier and Jolt are credible bake-off candidates,
but the engine decision should be made by Gurgur fixtures and recorded traces,
not feature lists or microbenchmarks.

## The vocabulary that prevents category errors

Several techniques are often called “prediction” even though they make very
different promises:

| Technique                        | Simulation at receiver                             | What crosses the network              | Normal failure                         |
| -------------------------------- | -------------------------------------------------- | ------------------------------------- | -------------------------------------- |
| Deterministic lockstep           | Full simulation                                    | Inputs                                | Everyone waits, or simulations diverge |
| Snapshot interpolation           | None for replicated bodies                         | Render state                          | Added delay or buffer underrun         |
| State synchronization            | Full approximate simulation                        | Inputs plus partial body state        | Divergence and correction pops         |
| Player prediction/reconciliation | Selected local gameplay simulation                 | Inputs plus authoritative checkpoints | Rewind/replay correction               |
| Distributed object authority     | Different authoritative islands on different peers | Ownership plus body state             | Conflicting contacts and handoffs      |
| Extrapolation                    | Approximate forward motion                         | Older state                           | Bad guesses at collisions              |

In this guide:

- **authority** means the peer whose state is accepted as gameplay truth;
- **ownership** means the right to request or retain that authority;
- **simulation state** is what collision detection and the controller read;
- **presentation state** is what a frame renders;
- **interpolation** reconstructs a time between two known samples;
- **extrapolation** guesses after the newest known sample.

Keeping simulation and presentation separate is essential. A visually smoothed
transform must never quietly become the transform from which a contact is
solved.

## How the field got here

Early deterministic multiplayer commonly sent inputs and advanced the same
simulation everywhere. It is bandwidth efficient, but it depends on identical
ordered inputs and sufficiently deterministic code. One slow or lossy peer can
hold back the group. Glenn Fiedler recommends lockstep mainly for small player
counts and points out that floating-point determinism across platforms is hard
in his [snapshot interpolation history](https://gafferongames.com/post/snapshot_interpolation/).

QuakeWorld's decisive improvement for first-person games was to simulate local
movement immediately and later correct it from the server. Valve developed this
into a sharp division of labor:

- the server owns gameplay truth;
- clients send numbered user commands;
- the local player and selected entities are predicted;
- acknowledged commands let the client restore and replay unacknowledged input;
- non-predicted remote entities are rendered behind server time and
  interpolated;
- the server can rewind player history for latency-compensated hit tests.

Yahn Bernier's
[2001 client/server protocol paper](https://developer.valvesoftware.com/wiki/Latency_Compensating_Methods_in_Client/Server_In-game_Protocol_Design_and_Optimization)
describes that family of techniques. The public Source SDK makes the boundary
concrete rather than merely historical.

Physics-heavy cooperative games added another family: let the interacting peer
own an object and stream its state. Fiedler's
[2004 networked physics article](https://gafferongames.com/post/networked_physics_2004/)
already states the central limitation: client-owned prediction is tractable
when ownership is clear and those objects interact mostly with a static world.
His later
[VR networked physics implementation](https://gafferongames.com/post/networked_physics_in_virtual_reality/)
made distributed simulation work, but it required much more than an owner ID:
authority and ownership sequences, host arbitration, collision-driven authority
propagation, state synchronization on nonowners, quantization on both sides,
phase-aligned avatar samples, and a jitter buffer. It was explicitly aimed at a
trusted cooperative experience.

s&box generalizes object ownership and proxy behavior into engine facilities.
Gurgur copied much of that outer protocol shape. The important lesson from the
history is not that one technique won. It is that each technique is valid only
inside a deliberately constrained interaction model.

## Protocol-v5 Gurgur baseline analyzed

The canonical design is internally coherent:

- 60 Hz physics with four substeps on every authority;
- browsers own their player and one loose prop under a granted lease;
- Bun owns unleased bodies, mechanisms, joint graphs, and diagnostic actors;
- nonowners create kinematic collision proxies;
- state is published nominally at 30 Hz over unordered WebRTC data channels;
- remote presentation is delayed 100 ms and holds the newest sample rather than
  extrapolating;
- lifecycle and authority changes use reliable WebSocket messages with complete
  state;
- disposable state uses per-recipient acknowledged baselines and a 250 ms
  resend horizon.

The implementation has real strengths:

- [`StateReplicationPeer`](../packages/engine/src/state-replication.ts) advances
  delta baselines only from acknowledgements and keeps independent history per
  object;
- [`StateReceiver`](../packages/engine/src/state-replication.ts) rejects stale
  authority versions and handles 16-bit sequence wrap;
- authority handoffs carry full state and disconnect reclamation is explicit;
- packets are bounded and malformed binary input is tested;
- fixed joint graphs already use the safer target-input pattern: the browser
  owns an exclusive manipulation claim, while Bun retains the complete dynamic
  graph and applies targets with a native control joint.

The important implementation facts behind the current risks are:

- [`NetworkObjectState`](../packages/engine/src/types.ts) has
  `authorityVersion` and `stateSequence`, but no source tick. `serverTick` exists
  in pongs and debug snapshots, not in each disposable sample.
- [`PresentationBuffer`](../apps/web/src/presentation.ts) records
  `receivedAtMs`, queries `now - 100ms`, linearly interpolates position, and
  nlerps rotation. It cannot distinguish producer cadence from network cadence.
- [`physics-worker.ts`](../apps/web/src/physics-worker.ts) applies a remote body
  packet with immediate `setBodyTransform` and `setBodyVelocity`. Rendering is
  delayed, but the collision proxy jumps on packet delivery.
- Browser-owned player and held-prop state is published from the worker at
  nominally 30 Hz. Bun coalesces all state in another 30 Hz timer before
  recipient-specific clustering.
- Both Bun and the worker cap catch-up at four ticks. Bun records shed time as
  `discardedOverloadSeconds`; the worker silently clamps it.
- [`server.ts`](../apps/server/src/server.ts) currently reports
  `maxStateAgeMs: 0`, so the field cannot support a release claim.

### What the current green suite proves

On 2026-07-31:

- `bun run check` passed 155 tests with 0 failures;
- `bun run test:browser` passed every real-Chrome smoke scenario;
- `bun run test:network --quick` passed six clients and 128 props for 1.5
  seconds.

The quick matrix reported:

| Profile | State age p95 | Advancing frames | Per-recipient traffic |
| ------- | ------------: | ---------------: | --------------------: |
| local   |      109.5 ms |             100% |          1.459 Mbit/s |
| typical |      171.5 ms |           98.60% |          1.466 Mbit/s |
| adverse |      223.0 ms |           99.30% |          1.458 Mbit/s |

Host p95/p99 tick cost was 3.28/8.79 ms. The same short run discarded 7.89 ms
of simulation time and reported `maxStateAgeMs: 0`.

Those results are useful baseline evidence, but their scope matters:

- the network harness uses real local Bun/WebRTC endpoints, then adds its own
  seeded impairment queues around them;
- clients are `werift` objects, not Chromium workers running the controller and
  Box3D;
- client motion is a synthetic `z += 5/30` at 30 Hz;
- the 128 props create host load and traffic, but the smoothness measurement
  follows one synthetic remote player and performs no contact;
- “advancing frame percent” only asks whether consecutive positions differ. It
  does not compare a rendered position with the authoritative position at the
  requested simulation time;
- the unit presentation test supplies perfectly spaced receipt times, which
  removes the very jitter that a buffer must handle.

A retained characterization now feeds four uniformly produced states at
receipt times `0, 33, 100, 100.1 ms`. The current buffer traverses almost a whole
33 ms source interval in 0.2 ms of presentation time. The test passes because it
documents today's behavior; it can become an accuracy assertion only after
source ticks exist.

## Gurgur versus s&box

The comparison below is against the pinned public revision, not assumptions
about proprietary native code.

| Concern              | s&box public                                                                                 | Gurgur v5                                                           | Consequence                                            |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| Authority vocabulary | An object is a proxy unless locally owned, or unowned on the host                            | Same effective rule                                                 | Strong match                                           |
| Handoff epoch        | Snapshot version changes with ownership                                                      | Separate `authorityVersion`                                         | Strong match                                           |
| Disposable baselines | Per-connection acknowledged/predicted slots; predicted entries expire after 250 ms           | Per-recipient acknowledged object states; resend after 250 ms       | Strong match                                           |
| Packet sizing        | Delta clusters cap at 1,200 bytes                                                            | State clusters cap at 1,200 bytes                                   | Strong match                                           |
| Handoff state        | `BeforeDropOwnership`, interpolation clear, forced full reliable snapshot                    | Full reliable ownership/drop state                                  | Same intent; s&box exposes a general pre-drop hook     |
| Rigidbody velocity   | Replicated while awake, zeroed at rest, forced current before drop                           | Included in body state and delta-compressed                         | Gurgur lacks explicit sleep/dormancy semantics         |
| Proxy physics        | Native `PhysicsBody.Move(target, dt)` every physics step; proxy motion is disabled           | Teleport transform and set velocity when a packet arrives           | Material gap for collision quality                     |
| Presentation time    | Generic transform samples are added using local `Time.NowDouble`, then queried 100 ms behind | Samples use `performance.now()` receipt time, queried 100 ms behind | Both inherit receipt-jitter distortion                 |
| Visibility           | Network culling and “always transmit” facilities                                             | All relevant state is broadcast                                     | Scaling gap, not the first correctness gap             |
| Physics integration  | Native engine body, scene stages, sleep, and control transitions                             | A new Box3D WASM wrapper behind Gurgur's adapter                    | Maturity and integration gap                           |
| Public proof         | Mock host/client integration and snapshot-version tests                                      | Codec, server/WebRTC, synthetic matrix, Chrome smoke                | Neither suite proves impaired cross-authority contacts |

Specific s&box behaviors worth adopting regardless of the larger authority
decision:

- [`Rigidbody.PrePhysicsStep`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Scene/Components/Collider/Rigidbody.cs#L605)
  drives a non-simulating proxy with `Move` at physics cadence instead of
  teleporting only on receipt.
- [`BeforeDropOwnership`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Scene/Components/Collider/Rigidbody.cs#L401)
  explicitly samples final linear and angular velocity.
- [`UpdateStateBeforeOwnerChange`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Scene/GameObject/GameObject.Network.cs#L943)
  clears interpolation and forces a reliable full state before the owner
  changes.
- Rigidbody velocity replication is sleep-aware rather than repeatedly treating
  a resting body as active.

Things not to copy uncritically:

- s&box's 100 ms default is a policy value, not evidence that 100 ms covers
  Gurgur's measured jitter distribution;
- its generic receipt-time transform buffer has the same missing source-time
  information;
- `IsProxy` tells code which state is writable. It does not make contacts across
  authority boundaries physically reciprocal;
- the public tests switch mock connection roles in one process. They validate
  protocol behavior, not internet physics quality.

## Gurgur versus Source SDK 2013

Source is not an object-authority engine in the s&box sense. Its useful lesson is
the boundary between predicted actors and shared physics.

### Shared physics props

On the server,
[`CPhysicsProp::VPhysicsUpdate`](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/server/props.cpp#L2912)
runs the VPhysics result into the entity, updates awake state, and marks network
state changed. The base entity send table includes simulation time and
frequently changing origin. On the client,
[`C_PhysicsProp`](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/client/c_physicsprop.cpp#L23)
receives awake state and uses the ordinary replicated base transform; its
physics pointer is null. Shared prop gameplay is therefore not independently
solved on each client.

Source does have client-only physics props. They are deliberately classified as
client-side/decorative; the corresponding multiplayer prop is removed from the
server in that mode. That is a semantic partition, not distributed authority
over one gameplay body.

This is the strongest precedent for keeping Gurgur's shared rigid bodies in one
Bun solver.

### Simulation-time interpolation

The server transmits
[`m_flSimulationTime`](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/server/baseentity.cpp#L262)
encoded against the tick count. Client origin and angles are registered as
[`LATCH_SIMULATION_VAR`](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/client/c_baseentity.cpp#L898),
whose documented sample basis is simulation time. When a non-predicted entity's
networked transform or simulation time changes, Source latches a simulation
sample. This preserves producer phase instead of treating packet-arrival gaps as
motion timing.

Source's interpolation amount is
`max(cl_interp, cl_interp_ratio / cl_updaterate)`, with a 100 ms default and
server-bounded ratio. The exact default is less important than the relationship
between update rate, interpolation coverage, and a shared timebase.

### Local-player prediction

Source user commands carry `command_number` and `tick_count`, are delta encoded,
and include a checksum. The client stores intermediate predicted frames.
[`CPrediction`](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/client/prediction.cpp#L1395)
restores a prior predicted frame, shifts acknowledged history, and runs
unacknowledged commands again. Prediction error is visually smoothed after the
gameplay state is corrected.

The key is selectivity: Source does not “predict physics” as one undifferentiated
feature. It predicts a controlled subset whose behavior is driven by replayable
input. Ordinary shared VPhysics props remain server-owned.

### The multiplayer physcannon exception

Source does create a local physics view for the confirmed held object. The
server selects and attaches the prop, then replicates `m_hAttachedObject` plus
the captured local position and player-space angles. On the client,
[`ManagePredictedObject`](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/shared/hl2mp/weapon_physcannon.cpp#L2060)
creates a VPhysics body for that entity and attaches the same `CGrabController`.
[`ItemPreFrame`](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/shared/hl2mp/weapon_physcannon.cpp#L2149)
updates it locally while the weapon is active.

This does not transfer authoritative shared-world physics to the client. It is
a narrow predicted presentation for the object under direct local control, with
server-confirmed attachment and authoritative replicated state. That distinction
is the missing client-feel lesson: server ownership and immediate owner-facing
held-object motion are not mutually exclusive.

The public SDK does not include all proprietary engine snapshot, channel,
baseline, or visibility implementation. It is evidence for entity time,
prediction, and physics boundaries, not a complete Source networking clone.

## What Gaffer actually recommends

Fiedler's articles describe three distinct solutions, not one recipe:

1. **Snapshot interpolation:** do not simulate replicated bodies at the receiver.
   Buffer state and render behind the authority. Hermite position interpolation
   can use endpoint velocity, and quaternion slerp maintains steadier angular
   speed. His experiments show that rigid-body extrapolation fails badly at
   moving contacts. See
   [Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation/).
2. **State synchronization:** simulate on both sides, send selected body state,
   feed corrections directly into simulation, apply lossy quantization on both
   sides, deliver updates through a frame-based jitter buffer, and smooth only
   the visual error. Burst loss will still produce corrections. See
   [State Synchronization](https://gafferongames.com/post/state_synchronization/).
3. **Distributed authority for trusted physics interaction:** arbitrate
   ownership at a host, carry separate authority and ownership sequences,
   transfer authority through interactions, and make held-object timing part of
   avatar state. This was substantially more complex than merely streaming a
   grabbed cube. See
   [Networked Physics in Virtual Reality](https://gafferongames.com/post/networked_physics_in_virtual_reality/).

Gurgur currently combines the ownership half of the third approach with
non-simulating proxies from the first approach. That hybrid is cheap and can
look good for a held object against static geometry. It does not provide the
state-synchronized remote solver or collision-driven island authority needed by
Fiedler's distributed dynamic-contact example.

Completing the distributed approach is possible, but conflicts with Gurgur's
selected invariants: no collision-based authority transfer, Bun-fixed joint
graphs, and non-simulating proxies. It would also require atomic island
authority, conflict correction, quantization feedback, and much more demanding
tests. Centralizing shared rigid bodies is the smaller and more legible system.

## The two root failures in detail

### 1. Two solvers cannot produce one contact

Suppose browser A owns held body `H`, while Bun owns dynamic body `B`.

At browser A:

```text
solve H(t) against kinematic proxy B(t - network delay)
publish the new H state
```

At Bun:

```text
solve B(t) against kinematic proxy H(t - network delay)
publish the new B state
```

The browser's impulse changes only authoritative `H`; Bun's impulse changes only
authoritative `B`. Each kinematic proxy can inject momentum into its local
solver, but neither peer applies the paired impulse calculated by the other.
Collision ordering, penetration depth, friction, sleeping, and constraint
islands also differ. The global result has no reason to conserve momentum or
even agree on which contact happened first.

More deterministic physics produces the same wrong topology more repeatably.
Higher send rate narrows the delay but does not create one contact manifold.
Reliable packets make stale state arrive reliably. A different interpolation
curve changes appearance but not causality.

There are only three principled exits:

- put the interacting dynamic island under one authority;
- make the interaction intentionally one-way through kinematic actors/targets;
- implement a complete distributed-island authority and correction system.

The recommendation uses the first two.

### 2. Receipt time is not simulation time

A monotonically increasing sequence answers “which state is newer?” It does not
answer “how far apart in simulated time were these states produced?”

With source samples at evenly spaced ticks but receipt times
`0, 33, 100, 100.1 ms`, a receipt-timed buffer stretches one source interval
over 67 ms and compresses the next into 0.1 ms. Delaying the query by 100 ms
moves the distortion later; it does not remove it.

The correct query is:

```text
renderHostTick = estimatedCurrentHostTick - interpolationDelayTicks
state = sample(authoritativeSamples, renderHostTick)
```

Arrival time remains useful for measuring delay, jitter, lateness, and clock
mapping. It must not be the trajectory's independent variable.

## Recommended target contract

### Authority classes

| Object class                  | Gameplay authority                                            | Browser representation                             |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Local player                  | Owning browser under current product contract                 | Geometric controller at local fixed tick           |
| Remote player                 | Its owning browser; Bun timestamps/relays accepted state      | Kinematic actor sampled on host timeline           |
| Loose rigid body              | Bun, including while held                                     | Kinematic collision proxy plus interpolated render |
| Joint graph, mover, mechanism | Bun                                                           | Kinematic proxies plus interpolated render         |
| Decorative local debris       | The local browser only                                        | Local physics, never persistent/gameplay state     |
| Grab/manipulation target      | Claiming browser supplies latest target; Bun arbitrates claim | Immediate local hand/beam/target feedback          |

The invariant should be stronger than “one owner per object”:

> Every dynamic contact island has exactly one solver that may mutate its
> gameplay state. Cross-authority actors are explicit kinematic inputs, never
> half of a reciprocal dynamic contact.

### Grabbing

The existing fixed-contraption manipulation path is the right primitive:

- Bun grants an exclusive claim reliably;
- the browser sends disposable target pose and sequence;
- Bun validates freshness and bounds;
- a native control joint drives the body while all of its contacts and joints
  remain in the Bun world;
- claim loss, disconnect, reset, and timeout are Bun decisions.

Use the same path for loose grabbable props. A release is then only removal of
the target constraint; there is no dynamic-body authority handoff. Bun already
has the actual release velocity because it simulated the body continuously.

The local interaction can still feel immediate if the hand pose, beam, reticle,
audio, and target marker react immediately. The authoritative held prop may use
a smaller local presentation delay when sufficient source samples exist, but it
must not be extrapolated through contacts or substituted into collision state.

### Player/body coupling

Under the current no-reconciliation contract, make the asymmetry explicit:

- player motion is resolved by its owning geometric controller;
- Bun receives the player as a time-stamped kinematic actor and may let it push
  host bodies;
- host bodies do not implicitly rewrite browser-owned player position;
- any gameplay shove, launch, or damage is an explicit authoritative event with
  defined owner behavior.

If this asymmetry is unacceptable, choose server-authoritative players and
Source-style prediction/reconciliation. Do not let both the client player and a
host rigid body independently decide a reciprocal impulse.

## A shared time model

Disposable state needs enough temporal identity to reconstruct the authority's
fixed-step timeline:

- a wide `sourceTick` or equivalent wrap-safe tick for every produced sample;
- `authorityVersion` for who may produce it;
- `stateSequence` for loss/duplicate/baseline handling within that authority;
- a discontinuity bit or reliable event for teleport, respawn, reset, and
  authority change.

For Bun-owned bodies, `sourceTick` is `serverTick`. For browser-owned players,
retain the browser physics tick and have Bun map it onto a host timeline when
accepting/relaying it. A pong containing a server tick is a start, but a robust
mapping must not revise an accepted sample's cadence when later delay changes.
Protocol v6 therefore anchors one immutable offset per authority epoch, rejects
backwards or implausibly future jumps, and leaves long-run offset/drift
monitoring to diagnostics and soak tests rather than retiming live samples.

Do not overload the identifiers:

- `authorityVersion` is not a packet sequence;
- `stateSequence` is not wall time;
- `worldEpoch` is not map revision;
- a delta baseline is not a presentation predecessor.

The receiver should maintain samples ordered by mapped source tick. Packet
arrival determines whether a sample was late; it does not change the sample's
time.

## Presentation and collision proxies

The first presentation goal is temporal accuracy, not a fancier curve:

1. sample a common host timeline;
2. choose an interpolation delay from update cadence and measured late-arrival
   rate;
3. hold at the newest state on underrun;
4. reset on declared discontinuities;
5. measure accuracy against the authority trace.

At 30 Hz, 100 ms covers three source intervals, but the protocol-v6 full matrix
measured 1.70% Adverse underrun at that setting. Gurgur therefore uses an
eight-tick (133.3 ms) bounded delay, which covers four source intervals and
passes the selected tail gate. Any future adaptive controller must stay within a
product-approved range and minimize delay while keeping underruns below its
gate; RTT alone is not the right input.

After timing is correct:

- use position Hermite interpolation with endpoint linear velocities when it
  improves the measured trace; clamp or fall back to linear around declared
  impacts and discontinuities;
- use quaternion slerp rather than nlerp for steadier angular speed;
- never infer a future rigid-body contact through extrapolation.

The physics proxy and rendered transform serve different consumers but should
sample the same source timeline:

- on each 60 Hz physics tick, query the proxy target appropriate for that
  simulation time;
- drive the kinematic body with the engine's velocity/kinematic-target API over
  the fixed `dt`, matching the useful s&box behavior;
- do not teleport a collision proxy only when a packet callback fires;
- do not let a visually smoothed transform feed back into gameplay.

## Transport and replication

The current transport split is fundamentally sound:

- reliable ordered WebSocket for bootstrap, lifecycle, authority, persistence,
  and reset;
- unordered `maxRetransmits: 0` WebRTC data channels for current state and
  owner/target streams.

[RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html) confirms that WebRTC data
channels support unordered partial reliability over SCTP/DTLS/UDP, including
stream interleaving support. It is appropriate for disposable state, provided
messages stay small and the application remains congestion-aware.

Required measurements are more important than a transport rewrite:

- actual source-to-receiver and source-to-presentation age;
- buffer occupancy and underrun duration;
- `bufferedAmount`, dropped/coalesced states, and recovery time;
- packet size distribution and fragmentation;
- per-recipient useful and total bit rate;
- late ACK/baseline misses;
- time discarded by either fixed-step loop.

WebTransport datagrams could later remove SCTP-specific complexity for a pure
client/server topology, but changing transport does not fix split authority or
receipt-time interpolation. It should be evaluated only against the same fault
and browser gates.

Replication optimizations should follow correctness:

- sleep/dormancy-aware state, as in s&box;
- priority accumulation so active/near/important bodies refresh first;
- relevance/visibility only when measured traffic or scale requires it;
- bounded position, velocity, and smallest-three quaternion quantization.

For snapshot interpolation, lossy values are visual/proxy targets and need not
be fed back into Bun's simulation. If Gurgur ever adopts state synchronization,
Fiedler's warning applies: quantize both simulations identically before each
step or corrections will continually introduce divergent starting states.

## Should Box3D be replaced?

Gurgur uses
[Box3D v0.1.0](https://github.com/erincatto/box3d/releases/tag/v0.1.0) through
[box3d.js](https://github.com/isaac-mason/box3d.js). The pinned commits matched
the latest upstream repositories at the research date. Box3D advertises
cross-platform determinism, recording/replay, continuous collision, joints,
sleep, and a web build. Those are unusually relevant strengths. Its only
release is also explicitly labeled alpha, and the JavaScript wrapper is version
0.0.2 with no GitHub releases. That is a real project risk.

The authority recommendation reduces the engine requirement: shared physics
only has to be authoritative and stable on Bun, not deterministic across every
browser. Browser parity still matters for the local controller, queries,
characterization, replay tooling, and any future predicted path.

| Engine                                        | Relevant strengths                                                                                                                                               | Risks to prove in Gurgur                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Box3D v0.1                                    | Already adapted; compact C API; cross-platform determinism and record/replay are stated goals; current fixtures cover all used joints and queries                | Alpha API/solver; very young wrapper; limited production history                                        |
| [Jolt](https://github.com/jrouwe/JoltPhysics) | Mature native engine, extensive constraints and diagnostics, WASM support, state recording; documented cross-platform deterministic build and CI hash validation | JS binding ownership/ergonomics, bundle/memory cost, browser thread constraints, adapter feature parity |
| [Rapier](https://github.com/dimforge/rapier)  | Official Rust/WASM JavaScript bindings and an explicit cross-platform deterministic package                                                                      | Exact behavior of stacks, control joints, conveyors, character queries, and existing content fixtures   |

[Jolt's determinism documentation](https://jrouwe.github.io/JoltPhysicsDocs/5.1.0/)
is especially useful as a model for a proof harness: ordered API calls, precise
floating-point settings, recorded state, and per-step hashes across native and
WASM targets.
[Rapier's official JavaScript documentation](https://github.com/dimforge/rapier/tree/master/typescript)
distinguishes its ordinary, SIMD, and cross-platform deterministic builds.

The decision rule should be:

> Keep Box3D if it passes the complete adapter conformance, replay,
> stability, browser/server, and performance gates. Replace it only when a
> named gate fails and a candidate passes the same artifact.

A fair engine bake-off runs the exact same compiled map fixtures and input log
through an engine-neutral adapter. It must cover:

- hull, compound hull, triangle mesh, height field, sensor, and filtering;
- high-speed CCD and thin geometry;
- sleep/wake and contact event ordering;
- friction, restitution, moving surfaces, and gravity scale;
- revolute, prismatic, spherical, weld, rope, rod, spring, and control joints;
- player casts, steps, slopes, crouch, moving support, and reaction impulses;
- stale handle/resource lifetime behavior;
- 16-player/128-prop and stress tick budgets;
- at least ten-minute stacks, contraptions, grab contacts, and reset/rebuild
  loops;
- recorded final and per-tick hashes in Bun and real browsers.

Raw “bodies per second” is not a selection criterion if the engine cannot
reproduce Gurgur's mechanisms and failure traces.

## Tests that can make a proof claim

A test never proves “the netcode is good.” It proves a named invariant over a
declared input and fault domain. Every release claim should name:

- the authority and observer;
- the authoritative trace/oracle;
- the network fault model and seed;
- the browser/runtime/architecture;
- the time interval;
- the metric and threshold;
- exclusions such as declared teleport/reset discontinuities.

### 1. Protocol properties

Keep the existing codec and baseline tests, then generate long randomized event
streams containing:

- full and delta state;
- packet loss, duplication, truncation, corruption, and reorder;
- 16-bit sequence wrap;
- authority changes, disconnect, reconnect, reset, and runtime-ID reuse;
- missing baselines and delayed ACKs.

Assert exactly:

- no stale authority or generation is accepted;
- accepted sequence is monotonic under wrap rules;
- every applied delta names retained baseline state;
- a full state eventually recovers from arbitrary finite loss;
- packet encoders never exceed their declared bound.

Use seeded property tests and save the minimized event stream for every failure.

### 2. Authority state-machine model

Build a pure reference model for claims, grants, drops, timeout, disconnect, and
reset. Compare every production transition with the model under randomized
reliable/disposable interleavings.

The most important invariant is observable, not inferred:

```text
for every gameplay body and physics tick:
count(peers allowed to advance it dynamically) == 1
```

If loose-body leases remain during migration, add an island fixture that proves
no dynamic contact crosses two authorities. Today that fixture should expose
the design gap.

### 3. Physics replay and engine conformance

Create one canonical binary artifact containing:

- compiled world bytes and revision;
- engine/version/build flags;
- initial complete body state;
- tick-numbered input/target/event log;
- per-tick normalized body state and event hash.

Replay it in Bun and Playwright-driven Chrome, Firefox, and WebKit/Safari where
available. Run at least 10,000 ticks and stop on the first divergent tick with a
small artifact containing both states. A final-state hash alone is insufficient
because errors can cancel.

Exact cross-runtime hashes are a determinism claim. If an engine deliberately
does not promise that, compare against documented numeric tolerances and require
bounded error without monotonic growth.

### 4. Snapshot presentation oracle

The authority records state `X*(tick)` before transport. The observer renders at
`renderHostTick`. Compare the presented state with the authoritative trace
interpolated at that same tick:

```text
position error = length(presented.position - oracle.position)
rotation error = 2 * acos(abs(dot(presented.rotation, oracle.rotation)))
timeline error = inferred authority tick of presented motion - renderHostTick
```

Measure p50/p95/p99/max, buffer underruns, longest freeze, backwards motion,
teleports, and speed error. Run paths with constant velocity, acceleration,
rotation, sleep/wake, bounce, a stack settling, a hinge, and an impact.

This test cannot be replaced by “95% of frames changed.” A smoothly moving body
can be smoothly wrong.

### 5. Contact-boundary torture tests

Use small worlds with analytic or single-world reference outcomes:

- equal-mass head-on collision;
- light held body hitting a heavy body and the reverse;
- glancing frictional impact;
- held body striking a sleeping stack;
- player kinematic actor pushing a free prop;
- grab/release during contact;
- two users contending for the same target.

Record maximum penetration, contact lifetime, sleep parity, momentum/energy
residual where physically applicable, world-state difference from an unnetworked
single-solver run, and visible discontinuity. Run each under local, typical,
adverse, burst-loss, and receiver-stall profiles.

The decisive present-day experiment is one browser-owned held prop colliding
with one Bun-owned prop. It should be expected to disagree with the single-world
oracle. The replacement target-driven version should keep the Bun trace
identical for the same received target event log, independent of how an observer
renders it.

### 6. Actual-browser impaired end to end

The release path must launch the production page in real browsers and exercise:

- the module physics worker and real Box3D WASM;
- the actual input/controller, renderer, and presentation loop;
- the real WebSocket and WebRTC data channels;
- at least two independent browser processes;
- 60, 120, and 144 Hz render scheduling;
- main-thread stalls, worker stalls, background/foreground, and clock drift;
- burst loss (Gilbert-Elliott), jitter, reorder, duplicate, bandwidth collapse,
  and recovery;
- reconnect, reset, grab contention, release, and contraption control;
- real host and browser trace export.

The current Chrome smoke is a good functional gate. The current profiled
`werift` matrix is a good transport/load gate. Neither substitutes for their
combination.

### 7. Soak and overload

A fixed-step loop may clamp to prevent the spiral of death, as described in
Fiedler's [fixed timestep article](https://gafferongames.com/post/fix_your_timestep/).
But discarded time is a correctness event, not just a performance counter.

The gate should fail or explicitly classify any interval in which:

- Bun discards wall time;
- the browser worker drops accumulated fixed ticks;
- state age grows without bound;
- data-channel backpressure stays above the cutoff;
- the presentation buffer remains underrun beyond its allowance.

Soaks need periodic hashes and trace checkpoints so a five-minute-old
divergence is diagnosable.

## Provisional quantitative gates

These are starting proof budgets, not selected canonical values:

| Property                                         |                   Typical profile |                   Adverse profile |
| ------------------------------------------------ | --------------------------------: | --------------------------------: |
| Stale authority/generation accepted              |                                 0 |                                 0 |
| Dynamic simulators per gameplay body/tick        |                         exactly 1 |                         exactly 1 |
| Presentation buffer underrun                     |                      <0.1% frames |                        <1% frames |
| Timeline error, excluding declared discontinuity |               p99 <1 physics tick |              p99 <2 physics ticks |
| Constant/ballistic path position error           |                         p95 <2 cm |                         p95 <5 cm |
| Rotation error                                   |                           p95 <1° |                           p95 <3° |
| Ordinary visible discontinuity                   |                             <5 cm |                            <10 cm |
| Source-state age                                 | measured, bounded, nonzero metric | measured, bounded, nonzero metric |
| Discarded fixed-step time in release run         |                                 0 |                                 0 |
| Host tick cost                                   |      retain p95 <8 ms, p99 <12 ms |      retain p95 <8 ms, p99 <12 ms |
| Recipient traffic at 128 relevant props          |                  retain <2 Mbit/s |                  retain <2 Mbit/s |

Contact fixtures should use the unnetworked one-solver trace as their oracle and
set tolerances from engine numerical behavior. A networked result should not be
allowed extra energy or penetration merely because its frames look smooth.

## Historical protocol-v6 decision summary

The most valuable parts of protocol v5 should survive:

- separate reliable lifecycle/authority from disposable current state;
- per-object authority versions and sequences;
- acknowledged delta baselines and bounded clusters;
- fixed 60 Hz simulation with four substeps;
- no remote rigid-body extrapolation;
- Bun-coordinated lifecycle, persistence, claims, reset, and deletion.

Decision 0022 selected and protocol v6 implemented:

- add a shared source-tick timebase and oracle-based presentation gates;
- replace receipt-callback proxy teleports with fixed-tick kinematic targets;
- centralize all shared rigid bodies in Bun and use disposable target control
  for loose grabs;
- declare player/body coupling one-way, or adopt the larger Source-style
  player prediction/reconciliation model;
- retain Box3D until another engine passes the same adapter conformance suite.

Decision 0024 subsequently keeps Bun's shared-body authority and source-time
model, but moves players to Bun authority, replaces loose targets with numbered
commands and checkpoints, predicts the local player plus one confirmed held
body, removes fixed collision delay, and reconciles by restore/replay. Decision
0025 extends only the local contact boundary to four checkpoint-selected loose
bodies while keeping Bun authoritative. The make-or-break principle remains
simple:

> Networked physics is correct when authority, time, and test oracle describe
> the same world. Smooth frames are presentation evidence; they are not physics
> evidence.
