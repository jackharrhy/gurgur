# 0026: Interpolate predicted props on fixed-step timestamps

## Decision

The local player presents the newest completed prediction immediately. Predicted
loose props render one 60 Hz tick behind their own simulation, interpolating
between completed poses without extrapolation. This adds about 17 ms of visual
delay to props while leaving input sampling, player movement, physics stepping,
and server authority unchanged.

The worker publishes every completed fixed step, including catch-up steps, with
its scheduled production timestamp. The worker and main thread normalize their
performance clocks through `performance.timeOrigin`. Rendering uses those
timestamps, not message arrival spacing.

A checkpoint replaces the latest local result even when its prediction sequence
is unchanged or its estimated server tick rewinds. Reconciliation applies the
same actual pose correction to the retained interpolation endpoints. One
decaying visual offset preserves continuity; ordinary movement does not restart
it. Returning a prop to authoritative presentation applies that offset before
any final transition step bound.

## Rationale

During a fast swing, a prop can legitimately travel roughly 16 cm per physics
tick. Independent worker and render scheduling can deliver zero completed ticks
before one frame and two before the next. Immediate latest-pose presentation
then produces a visible 32 cm step even on localhost. A per-frame motion clamp
hides that symptom by limiting valid physical movement, and changes behavior
with display rate. Interpolation preserves the physical trajectory at both
60 and 120 Hz for the cost of one tick of prop presentation latency.

Network freshness and prediction revisions require separate rules. Disposable
server samples must advance authority, sequence, and source time. A newly
replayed local pose replaces its predecessor regardless of packet sequence;
applying network duplicate rejection to it drops valid corrections.

Source tick alone also cannot prove client/server simulation equivalence.
Bun consumes newest delivered intent once per tick; the browser predicts pending
commands. Jitter can give the two sides different input histories with the same
tick label. Identical-command adapter traces establish physics parity; browser
tests establish response time, release continuity, and convergence.

This refines the presentation portion of decision 0024. The bounded prediction
set, shared controllers, fixed-step simulation, and transport semantics remain
as selected there and in decision 0025.
