# 0024: Use Source-style bounded player and held-prop prediction

Status: accepted, 2026-08-02. Supersedes the browser-player authority portion
of [0019](0019-object-ownership-netcode.md), the player/proxy and loose-grab
parts of [0022](0022-centralized-shared-rigidbody-physics.md), and the mesh-only
speculation selected by [0023](0023-client-feel-presentation.md). The
one-held-body contact boundary is refined by
[0025](0025-bounded-contact-island-prediction.md).

## Decision

Bun is authoritative for every player and shared rigid body. A browser sends
numbered input commands, predicts its local player, and, after Bun confirms a
loose-prop claim, predicts that one held body. Bun and the browser call the same
player and grab controllers through real Box3D worlds at 60 Hz with four
substeps. The predicted result is a disposable local cache and is never
published as gameplay truth.

Protocol v7 sends four-command redundant unordered input bundles and
owner-specific authoritative checkpoints. Each checkpoint contains Bun's
server tick, last processed command, complete player state, and an optional
held-body state plus grab seed. The browser restores the checkpoint, rewinds
nearby proxy history to the replay ticks, replays up to 128 unacknowledged
commands, and then returns ordinary proxies to their newest state. Physics
correction is immediate; player and held-body render error decays over 100 ms.

Ordinary browser collision proxies use the newest accepted Bun state rather
than the v6 eight-tick collision timeline. Nearby, supporting, or touching
rigid bodies use the same collision-aligned pose for presentation, with a
100 ms transition and distance/time hysteresis. Distant bodies and remote
players keep buffered interpolation. A held prop is rendered from its predicted
dynamic body, never from a target transform.

Joint-connected graphs remain Bun-only. Explicit contraption manipulation
retains its server-native control joint and disposable target. Protocol v7
removes browser-authored player/body truth and loose-prop target packets.

Box3D remains selected. A replacement must first demonstrate that identical
serialized state and command streams fail the Bun/browser conformance trace or
violate measured runtime budgets, then pass the same artifact itself.

## Evidence

Clean `main` at `d604849` had the best local feel because the browser simulated
its player and a held prop together with the real Box3D controllers. It also had
the correctness defect that player/prop contacts could cross authorities and
remote state remained visibly delayed.

The protocol-v6 overlay centralized shared bodies but created three conflicting
poses. A prop mesh followed its grab target in one frame, the collision proxy
remained eight ticks old, and Bun simulated against a separately delayed player
proxy. That made pickup visibly snap and made walking onto props collide with a
pose different from the one on screen. Its tests accepted those defects: the
unit oracle required one-tick target arrival, the pickup smoke accepted any
5 cm movement within 50 ms, and release allowed a 50 cm discontinuity.

Source SDK 2013 provides the selected movement structure: the server is truth,
shared movement code runs locally, authoritative checkpoints restore state, and
unacknowledged commands replay. Its multiplayer physcannon also demonstrates
that local held-object physics is different from assigning that object gameplay
authority. `arctic-char` supplies the directly applicable pattern of sampling
remote collision history at each replay tick. S&box remains useful evidence for
generation-bearing object identity, explicit proxies, authority versions,
bounded state replication, and server-native control joints, but generic object
ownership is not a substitute for player command prediction.

Gaffer's fixed-timestep and snapshot-interpolation work supplies the time-model
constraints: physics never steps from render or packet time, interpolation is a
presentation policy, and deterministic claims must be limited to a measured
input/state trace. None of these references requires deterministic full-world
lockstep in two Wasm instances.

Protocol-v7 evidence includes independent player/held-body simulation traces at
`1e-4` metre/radian tolerance, a nonteleporting pickup fixture, newest-proxy
walk/stand/cross contact tests, redundant command loss/duplicate/reorder tests,
real Bun/WebRTC checkpoints and contention, production-browser behavior gates,
and a four-timeline trace recorder.

## Rejected alternatives

- **Keep v6 and tune interpolation.** Interpolation cannot make a mesh target,
  an eight-tick collision proxy, and Bun's current physics pose agree.
- **Return to clean main's split authority.** It recovers local feel but reopens
  the authoritative contact and remote-state defects.
- **Use a mesh-only speculative held transform.** It can respond quickly while
  being physically impossible and contradicting local collision.
- **Predict an entire joint graph.** Its rollback state and constraint contacts
  are outside the bounded player/one-loose-body requirement.
- **Run deterministic full-world lockstep.** Browser/server floating-point and
  scheduling parity are unnecessary when checkpoints and bounded replay define
  the contract.
- **Replace Box3D first.** The diagnosed failures are authority, time, and
  presentation failures; the existing solver passes the shared trace.

## Consequences

- Local movement and confirmed loose pickup respond without an RTT while Bun
  remains the only gameplay authority.
- Player/shared-body contacts are solved authoritatively in Bun, while replay
  uses historical proxies to reduce correction error.
- Reciprocal local contact can be predicted only for the bounded local player
  and confirmed held prop; the rest of the world remains proxy geometry.
- Checkpoint size, replay count, contact/support identities, correction error,
  and interaction presentation become required diagnostics.
- Protocol v7 is intentionally wire-incompatible with v6. Persistence requires
  no migration.
- Automated gates can reject known bad feel, but merge still requires a
  side-by-side play test against clean `main`.
