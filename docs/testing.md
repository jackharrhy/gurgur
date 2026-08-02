# Testing

`bun run check` runs formatting, lint, TypeScript, unit/simulation tests,
persistence/content tests, and the real Bun/WebRTC protocol-v6 integration
suite.

## Network commands

- `bun run test:network` runs the 16-player/128-prop release matrix.
- `bun run test:network -- --quick` runs a six-client development matrix.
- `bun run test:network stress` reports 32 players/256 props without blocking a
  release.
- `bun run test:browser` runs real Chrome movement/banding, host-owned
  pickup/release, contention, disconnect cleanup, connected reset, and
  contraption scenarios.
- `bun run test:browser movement|pickup|contention` selects one browser
  scenario.

Run the release performance matrix without a concurrent browser suite or other
CPU-heavy workload. Host tick time, state age, and underrun are wall-clock
budgets; co-scheduling another stress gate invalidates those measurements.

The transport harness uses a real Bun server and real unordered WebRTC data
channels. Seeded impairment layers apply. Its report includes state age,
analytic presentation path error, buffer-underrun frames, advancing frames,
traffic, stale authority, host source-state age, fixed-step discard, and host
tick cost:

| Profile |    RTT | Jitter | Loss |
| ------- | -----: | -----: | ---: |
| Local   |   2 ms |   0 ms |   0% |
| Typical |  80 ms |  20 ms |   1% |
| Adverse | 150 ms |  40 ms |   5% |

## Proof hierarchy

Tests distinguish transport success, presentation accuracy, and physics
correctness. A changing-frame count is useful as an underrun symptom but is not
a physics oracle.

1. Codec tests prove exact protocol-v6 bounds, source-tick round trips,
   generations, acknowledged baselines, resend, and sequence rollover.
2. The isolated source-clock mapper feeds the same fixed source cadence through
   variable arrival delay and must retain its tick spacing, including uint32
   rollover. Improving delay cannot revise the epoch offset; backwards and
   implausibly future clocks are rejected.
3. Presentation tests use a virtual host clock and analytic constant-velocity
   path. Jittered receipt times must not change the source-tick sample result;
   the buffer holds rather than extrapolating past its newest state. Adaptive
   tests prove a four-tick localhost floor, per-track isolation, bounded rise,
   and a render timeline that never runs backwards.
4. Externally owned player-proxy tests inject mapped samples at arbitrary
   arrival times and assert the Bun proxy samples the eight-tick source
   timeline.
5. Adapter record/replay runs the same fixed-step contact fixture twice and
   compares every authoritative trace row. Position-and-rotation kinematic
   target tests gate the proxy primitive itself.
6. Host tests reject every browser-authored body state, assert every shared prop
   remains fixed Bun authority, and exercise loose-prop contact/control/release
   in the one solver.
7. Real WebRTC tests prove browser player tick mapping, loose-prop
   first-claim-wins, disposable target motion, unchanged body authority, release,
   reset, and jointed manipulation. While a body is manipulated, its accepted
   transport trace must contain adjacent source ticks; a 30 Hz-only result has
   two-tick gaps.
8. Real Chrome tests prove the production worker, Wasm, input, claim UI, target
   stream, presentation, and release path together. Two clients use independent
   Chrome processes; disposable state and targets run through seeded Typical or
   Adverse impairment. A deliberate main-thread stall must not discard worker
   time, while a deliberate worker stall must increment the shared discard
   metric and recover.
9. The isolated speculative presenter proves response within one 60 Hz interval,
   immutable authoritative input, no effect on unrelated bodies, bounded release
   correction, and lifecycle/reset cleanup. The real Chrome pickup gate then
   proves the production target cadence and visible response under impairment.

## Release budgets

The 16-player/128-prop gate requires:

- exactly one dynamic simulator per shared gameplay body;
- zero accepted browser-authored body states or stale authority/generation;
- mapped source cadence error of zero ticks in deterministic tests;
- presentation path error p95 below 2 cm Typical and 5 cm Adverse for analytic
  constant-velocity traces;
- presentation buffer underrun below 0.1% Typical and 1% Adverse;
- remote state age p95 below 200 ms Typical and 300 ms Adverse;
- average state traffic below 2 Mbit/s per recipient;
- zero discarded fixed-step time in a release run;
- host simulation tick below 8 ms p95 and 12 ms p99.

The real-browser local movement gate measures input edge to presented player
state and permits one fixed worker tick plus the next render frame. Pickup gates
assert that the prop owner remains null, `authorityVersion` does not change,
the worker produces at least 20 target states per 500 ms window, speculative
loose-prop response appears within 50 ms of a look input under the seeded
Adverse profile, motion ultimately comes from host state, and release produces
no single-frame solver/handoff discontinuity. The movement scenario also asserts
that an active localhost host-body render track stays at or below five ticks.

## Physics conformance and replacement

The Box3D adapter remains replaceable. An engine candidate must run the same
fixture inputs through the same adapter-level artifact and report:

- per-tick pose, linear/angular velocity, awake state, contact and sensor events;
- controller result and kinematic-target result;
- constraint anchor/error and manipulation target/error;
- maximum penetration, contact lifetime, sleep parity, and finite-state checks;
- deterministic replay trace equality within an explicitly recorded tolerance.

Engine choice is made from these Gurgur traces plus real browser/server cost and
stability. A feature list or microbenchmark cannot justify replacing the solver,
and a solver replacement cannot repair an authority or time-model defect.
