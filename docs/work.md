# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-08-01.

## Current state

Protocol v6 implements the centralized shared-rigidbody slice selected by
[decision 0022](decisions/0022-centralized-shared-rigidbody-physics.md):

- browsers simulate and publish only their own geometric players from a
  dedicated 60 Hz Box3D module worker;
- Bun simulates every shared rigid body, including loose props while held;
- loose grabs and jointed manipulation use the same exclusive disposable
  target plus Bun-native control-joint path;
- prop ownership request/drop, browser-authored body state, and `grab-lease`
  transfer policy have been removed;
- replicated body/player state carries a uint32 source physics tick;
- browser ticks are anchored once per authority epoch without copying packet
  jitter or later offset revisions into their cadence;
- browser collision proxies and Bun's browser-player proxies sample a fixed
  eight-tick source timeline; collision proxies move through fixed-tick
  position-and-rotation kinematic targets;
- browser render tracks adapt independently between four and eight ticks without
  rewinding their timelines;
- confirmed loose-prop claimants get an isolated target-following rendered view
  with bounded release correction; it never enters physics, queries, transport,
  or persistence;
- active manipulation targets and changed manipulated-body hot states are
  produced at 60 Hz while ordinary state remains 30 Hz;
- reliable bootstrap, lifecycle, player authority, respawn, and reset carry
  complete state;
- unordered player/cluster traffic retains bounded binary deltas,
  acknowledgements, resend, backpressure coalescing, and stale rejection.

The proof surface now includes:

- isolated source-tick mapping with variable delay and rollover;
- virtual-clock analytic presentation paths that reject receipt-time bursts;
- adaptive render-delay isolation and monotonic timeline tests;
- speculative held-prop response, immutability, unrelated-body isolation,
  correction-bound, and lifecycle tests;
- pure fixed-step overload accounting shared by Bun and the browser worker;
- host player-proxy timeline sampling and reliable discontinuity reset;
- Box3D kinematic transform and deterministic contact trace/replay tests;
- host rejection of browser body state and single-solver loose-prop control;
- real Bun/WebRTC player-tick mapping, loose pickup, contention, release, reset,
  contraption manipulation, and adjacent-tick hot-body delivery;
- profiled analytic path error and buffer-underrun gates under seeded loss,
  jitter, latency, and load;
- two-process real Chrome coverage with production workers, seeded disposable
  impairment, deliberate main/worker stalls, and discard/recovery assertions.

Source-style physics contraptions remain implemented as one Bun-owned vertical
slice: native joints, authored local frames, conveyors, gravity fields,
persistence, procedural constraint presentation, and target-driven direct
manipulation all solve without graph authority transfer.

## Client-feel follow-up gate

The presentation follow-up selected by
[decision 0023](decisions/0023-client-feel-presentation.md) is complete:

- the repository-wide format/lint/type/unit/integration gate passes 171 tests;
- every production Chrome scenario passes, including an active localhost
  host-body render delay of at most five ticks, at least 20 manipulation targets
  per 500 ms, and visible loose-prop response within 50 ms of look input under
  seeded Adverse impairment;
- the complete Adverse pickup/turn/release feel path passes five additional
  consecutive production-Chrome runs;
- real WebRTC delivery contains adjacent manipulated-body source ticks while the
  object remains Bun-owned at one unchanged authority version;
- the isolated 16-player/128-prop matrix reports about 0.000057 cm analytic path
  error p95, 0.071% Typical and Adverse buffer underrun, 155 ms Typical and 216 ms
  Adverse state age p95, zero correctness errors or stale authority, zero host
  discarded time, and about 1.27/1.91 ms host tick p95/p99.

## Protocol v6 release gate

The migration gate is complete:

- the repository-wide format/lint/type/unit/integration check passes;
- every production Chrome scenario passes, including host-owned pickup/release,
  first-wins contention, disconnect cleanup, reconnect/reset, contraptions,
  separate browser processes, Adverse disposable impairment, and main/worker
  stall probes;
- the 16-player/128-prop matrix reports approximately 0.000057 cm analytic path
  error p95, 0.071% Typical and Adverse buffer underrun, 155 ms Typical and
  216 ms Adverse remote state age p95, zero correctness errors, zero stale
  authority, and about 1.27/1.91 ms host tick p95/p99;
- source-state age and browser/host discarded catch-up time are real metrics,
  not placeholders; the ordinary release paths discard zero time;
- the Box3D soak completes 10,000 handle churn cycles and 1,000,000 fixed ticks
  with checkpoint hash
  `10640c0c30c66aa0c71f601e2f4bdc8b01a558f8b179f21314683f7947fffcd1`.

## Active focus

Box3D remains pinned. A Rapier or Jolt bake-off is deferred until the same
engine-neutral fixture/trace artifact can run against a candidate in Bun and a
real browser. Solver replacement is not required to complete protocol v6.

The stronger isolated Box3D shadow-body view remains deferred unless retained
contact fixtures or blinded play testing show that the selected target-following
presentation is physically implausible. Source-style server-player prediction
remains contingent on a product requirement for reciprocal immediate
player/shared-body response.

Breaking joints, pulley systems, wheel/suspension joints, runtime joint
creation, reciprocal player/body dynamics, Source-style player prediction, and
conveyor texture scrolling remain deferred product/architecture work.
