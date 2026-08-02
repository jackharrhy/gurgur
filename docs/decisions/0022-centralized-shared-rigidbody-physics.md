# 0022: Centralize shared rigid-body physics and replicate source time

Status: accepted, 2026-07-31. Supersedes the prop-ownership portion of
[0019](0019-object-ownership-netcode.md) and generalizes
[0021](0021-fixed-authority-contraption-manipulation.md).

## Decision

Bun is the only dynamic simulation authority for every shared rigid body,
including a loose prop while a player holds it. Browsers remain authoritative
for their geometric player controllers. Player/body coupling is explicitly
one-way: browser movement treats shared-body proxies as kinematic geometry;
Bun's source-timed kinematic player proxy may push Bun-owned bodies.

Loose pickup and contraption manipulation use one exclusive claim protocol. The
browser publishes a bounded disposable target; Bun applies it through a native
control joint and replicates only the resulting body state. Loose props use a
centre-of-mass anchor and contraptions may use a selected hit offset. Release
removes the joint without changing body type, solver, owner, or authority
version.

Every replicated object state includes the physics tick at which it was
produced. Browser-player ticks are mapped onto Bun's timeline at the authority
boundary with one immutable offset per authority epoch; subsequent packet delay
cannot retime that cadence, and implausible clock jumps are rejected. Rendering,
browser collision proxies, and Bun's browser-player proxies sample that source
timeline with bounded interpolation and no rigid-body extrapolation. Ordinary
packet receipt time is diagnostic data, not simulation time.

Protocol v6 removes prop ownership request/drop messages and the `grab-lease`
transfer policy. Reliable lifecycle and player-authority messages remain
separate from disposable current state and manipulation targets.

Box3D remains the selected solver. Replacement is considered only after another
engine passes the same adapter record/replay, contact, controller, constraint,
real-browser, and performance conformance suite.

## Evidence

The local
[networked-physics deep dive](../networked-physics-deep-dive.md) compares the
pinned s&box public implementation, Source SDK 2013, Gaffer's networked-physics
and fixed-timestep work, Gurgur's previous protocol, and candidate WebAssembly
solvers.

The previous browser-owned held-prop design split one contact across two
authoritative solvers. Each solver saw the other body as a delayed kinematic
proxy, so there was no place that could apply one equal-and-opposite contact
impulse to both gameplay states. No amount of interpolation could repair that
authority boundary.

Source keeps ordinary shared props in the server physics world. S&box's public
control-joint path also demonstrates that compact grab target state does not
require body ownership transfer. Gurgur already had that path for jointed
contraptions, so extending it to loose props removes a solver boundary instead
of adding a new framework.

The prior wire state also lacked source time. Its presentation and collision
proxies used packet receipt callbacks, allowing jitter to change apparent
speed and collision-proxy velocity. Protocol-v6 tests now preserve fixed source
cadence through variable arrival delay, use a virtual-clock path oracle, and
drive proxy transforms only at fixed-step boundaries.

The profiled six-tick/100 ms buffer missed the selected Adverse underrun budget
(1.70% of frames). The shared browser-render, browser-collision, and Bun
player-proxy delay is therefore eight ticks/133.3 ms; the full release matrix
measures 0.071% Adverse underrun with effectively zero analytic path error.
Decision [0023](0023-client-feel-presentation.md) subsequently splits browser
render policy from the still-fixed collision and host player-proxy policy.

## Rejected alternatives

- **Keep grab leases and improve smoothing.** Smoothing can hide a split
  contact but cannot make two authorities conserve the same impulse.
- **Transfer an entire collision island.** This requires authoritative island
  discovery, atomic multi-object handoff, graph lifecycle, persistence, and
  collision-boundary propagation. Gurgur's product does not need that
  complexity.
- **Make players and props fully server authoritative now.** This is the robust
  route for reciprocal player/body response, but acceptable local movement then
  requires tick-numbered inputs, prediction, reconciliation, and replay. That
  larger product change remains deferred.
- **Replace Box3D first.** Solver choice cannot repair missing source time or a
  split authority graph.

## Consequences

- Every shared rigid-body contact is solved once in Bun's world.
- Held-prop latency follows target transport instead of pretending a second
  browser simulation is authoritative.
- Prop contention remains reliable and first-claim-wins.
- Release has no pose/velocity handoff discontinuity.
- Browser player movement stays locally responsive without prediction.
- Reciprocal prop-to-player pushback is outside the selected contract.
- Source-tick mapping, proxy-buffer health, target latency, and authoritative
  trace comparison become required proof surfaces.

Decision [0023](0023-client-feel-presentation.md) supplements the presentation
consequences without changing Bun's rigid-body authority.
