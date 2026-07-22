# 0010: Budget remote state separately from local prediction

Status: accepted on 2026-07-22.

Keep local prediction inputs and the five-metre dynamic-contact region on every
20 Hz snapshot packet. Stagger unrelated dirty moving bodies across alternate
packets, yielding a 10 Hz remote-body stream, and present unrelated state with a
250 ms interpolation delay.

The real 16-client harness exposed two separate problems. First, sending all 128
initially active stress bodies at 20 Hz exceeded the Adverse profile's 1 Mbit/s
link during world settlement. That inflated acknowledgement latency and snapshot
age even though local-contact reconciliation needed only nearby bodies at the
full rate. Second, the headless clock estimator treated a newly arrived snapshot
as current server time instead of including the profile's one-way transit time.
Once measured on the same time basis as the browser ping/pong estimator, 150 ms
did not cover the deterministic Typical retransmission trace's interpolation
tail.

The selected cadence preserves the authoritative 60 Hz fixed physics step, 20 Hz
player acknowledgements, complete same-tick nearby prediction state, ordered
WebSocket semantics, and final sleep replication. It only spends less bandwidth
on unrelated presentation state. A 250 ms remote buffer covers two 10 Hz body
samples and keeps Typical extrapolation below its existing one-percent gate.
Interpolation builds per-body tracks from sparse packets so the staggered stream
remains smooth instead of freezing on packets assigned to another body group.
Reliable packets delivered together are retained as a bounded history batch;
only the newest reconciles local prediction, so an older body's delta is not
discarded merely because the next packet belongs to another stagger group.
The same queue is used while the immutable world bundle loads, preserving the
initial complete snapshot. When a remote player track runs dry, horizontal
velocity is derived from its last two positions because the controller packet
only carries explicit vertical velocity.
If the server socket itself becomes backpressured, its single replaceable pending
packet is a complete current-state discontinuity rather than a sparse group. This
keeps the queue bounded without losing an unsent sleep or stagger-group delta.

Mixed-profile aggregate metrics remain raw diagnostic data. Canonical movement
budgets are evaluated separately for Local, Typical, and Adverse. Constrained is
reported as a saturation profile because its continuous 256 Kbit/s bottleneck is
intentionally below the initial replicated-state production rate; including it
in one aggregate quality headline previously made passing profile results look
like a movement regression.

Evidence lives in the replication-cadence test in
[`../../apps/server/test/game.test.ts`](../../apps/server/test/game.test.ts), the
clock-aware real harness in
[`../../tools/network-harness/src/real-harness.ts`](../../tools/network-harness/src/real-harness.ts),
and the deterministic `bun run harness:matrix` gate.
