# 0023: Separate visual latency from gameplay authority

Status: accepted, 2026-08-01. Supplements
[0022](0022-centralized-shared-rigidbody-physics.md).

## Decision

Keep Bun as the sole dynamic authority for every shared rigid body, but stop
using the eight-tick Adverse-network margin as a universal browser presentation
delay.

Each ordinary remote render track adapts independently between four and eight
source ticks. Recent active-state lateness and buffer underruns raise its desired
delay; increases slew without moving the presentation timeline backwards,
underrun demand is held for two seconds, and decreases occur slowly. Browser
collision/query proxies and Bun's externally owned player proxies retain the
fixed eight-tick policy.

While a manipulation claim is active, the browser publishes its disposable
target at 60 Hz and Bun publishes that body's authoritative result as a 60 Hz
hot state. Ordinary body and player state remains 30 Hz.

After Bun reliably confirms a loose-prop claim, the claiming browser may present
an isolated speculative transform for that prop's mesh. The transform follows
the local target over one 60 Hz interval. It never mutates the authoritative
snapshot, enters Box3D, answers a query, activates gameplay, becomes persisted
state, or appears in an outbound body-state packet. On release the visual offset
converges to Bun's adaptive render track at no more than 2 m/s and 2π rad/s.
Lifecycle removal and world replacement clear it. Contraption meshes remain
fully authoritative because presenting one part without its joint graph would
make a false physical claim.

This is visual speculation and visual reconciliation, not gameplay prediction.
Player movement, input replay, gameplay reconciliation, rigid-body
extrapolation, collision-based authority transfer, and browser-authored shared
body state remain excluded.

## Evidence

The
[client-feel investigation](../networked-physics-client-feel.md) measured the
previous localhost shared-body view at roughly the full 133.3 ms buffer delay.
It also found that a four-tick source buffer covered the sampled localhost
scheduling trace without underrun, while six ticks did not satisfy the selected
Adverse budget. Source SDK 2013's multiplayer physcannon demonstrates the
missing separation: ordinary shared props stay server authoritative, while a
confirmed attachment gets a local VPhysics presentation path instead of relying
on interpolation alone.

Focused deterministic tests isolate adaptive-delay behavior and speculative
presentation from transport. Production Chrome gates measure the actual worker,
target transport, renderer, and WebGPU path: the local active host-body track
must remain at no more than five ticks, target production must exceed the old
30 Hz cadence, look input must visibly move the speculative prop within 50 ms
under seeded Adverse impairment, and release correction remains bounded.

## Rejected alternatives

- **Keep one eight-tick delay for every consumer.** It meets the Adverse proxy
  underrun budget by imposing its worst-case latency on localhost presentation.
- **Reduce every proxy to four ticks.** A render view can reconcile; a collision
  proxy or Bun player proxy changes physics results and needs its independent
  conservative policy.
- **Return loose-prop authority to the browser.** That reopens the split-solver
  contact defect fixed by decision 0022.
- **Predict contraption parts with the target-following view.** A single part
  detached visually from its joint graph is misleading. A future shadow world
  must clone the relevant constraints before making that claim.
- **Replace Box3D.** Solver choice does not remove intentional buffering or the
  target round trip.
- **Move players to Bun now.** That requires tick-numbered input prediction,
  checkpoints, reconciliation, and replay, and is justified only by a product
  need for immediate reciprocal player/shared-body physics.

## Consequences

- Localhost observation latency is no longer forced to the Adverse proxy delay.
- The holder gets an immediate local loose-prop response after claim
  confirmation while Bun remains the sole gameplay truth.
- Visual and collision transforms for one object can intentionally differ; code
  and tests must preserve that boundary.
- Hot-state bandwidth grows only for actively manipulated bodies.
- Network degradation increases authoritative separation and convergence work,
  not local input-to-visual response after the claim.
- A Source-like isolated Box3D shadow world remains a later option if retained
  contact fixtures show that target-following presentation is not plausible
  enough.
