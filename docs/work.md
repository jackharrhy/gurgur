# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-08-02.

## Current state

Protocol v7 implements the Source-style recovery selected by
[decision 0024](decisions/0024-source-style-networked-physics.md):

- Bun simulates every player and shared rigid body at 60 Hz with four substeps;
- browsers send four-command redundant unordered input bundles and publish no
  player or loose-body gameplay state;
- each browser predicts its local player and one confirmed held loose prop with
  the same Box3D adapter, `stepPlayerController`, and `stepPropGrab` used by Bun;
- Bun sends owner-specific checkpoints at 30 Hz with the last processed command,
  complete player state, and optional held-body/grab state;
- browsers retain 128 commands, restore checkpoints, replay unacknowledged
  input, and sample nearby proxy history at each replay source tick;
- ordinary collision proxies use newest authoritative state instead of the v6
  fixed eight-tick collision timeline;
- held props render from their predicted dynamic bodies, and both player and
  held-prop reconciliation use 100 ms visual error decay;
- a confirmed grab's release edge is predicted during replay, and extraordinary
  release correction is presentation-rate-bounded instead of teleporting;
- interaction-relevant bodies blend to collision-aligned presentation over
  100 ms, remain relevant for 500 ms, and leave outside 2.5 m;
- loose claims and targets derive from Bun's authoritative player/input state;
  explicit jointed manipulation retains its Bun-native control-joint path;
- protocol-v6 browser-authored owned state, owner commits, and mesh-only
  speculative presentation have been removed.

The protocol-v6 implementation is preserved unchanged at archive commit
`90d32d6` on `codex/netcode-v6-centralized-archive`. Clean `main` at `d604849`
remains the golden local-feel reference.

## Proof surface

The automated surface now includes:

- protocol-v7 finite/bounds/round-trip coverage for redundant input bundles and
  checkpoints with and without held state;
- per-player deduplication, bounded ordering, one-command-per-tick consumption,
  monotonic acknowledgement, and single execution of action edges;
- independent Bun/browser Box3D adapters that agree for a player and free held
  prop within `1e-4` metres/radians for the same checkpoint and commands;
- pickup acceleration/velocity gates that forbid one-frame target arrival;
- walk, stand, and cross fixtures using newest loose-body proxies, with a 1 cm
  penetration and bounded grounded-transition budget;
- server-authoritative pickup, release, contention, disconnect, reset, and
  jointed manipulation through real Bun/WebRTC;
- production Chrome movement, physical pickup/release, contention, and
  contraption scenarios;
- a bounded trace with command/ack/replay/contact/support data and
  authoritative, collision, predicted, and rendered transforms;
- the 16-player/128-body real transport matrix and existing fixed-step/tick,
  state-age, traffic, underrun, and analytic-presentation budgets.

## Release gate

Automated implementation gate, 2026-08-02:

- `bun run check` passes formatting, lint, TypeScript, and all 174 tests;
- `bun run test:browser` passes movement, physical pickup/release, first-wins
  contention/recovery, and server-only contraption scenarios; the adverse
  pickup path also passed three consecutive isolated runs;
- the 16-player/128-body matrix passes with zero correctness/stale-authority
  errors, zero measured underruns, 100% advancing moving-oracle frames at 60 and
  120 Hz, approximately 0.74 Mbit/s per recipient, and 2.31/3.37 ms host tick
  p95/p99;
- localhost pickup must begin with bounded physical motion, never a mesh
  teleport, and release remains inside the browser discontinuity gate;
- local movement must respond inside the bounded input/worker/render path and
  active localhost remote presentation settles to at most five ticks;
- future network-matrix changes must retain less than 2 Mbit/s per recipient and
  the 8/12 ms host tick p95/p99 budgets;
- traces must be inspected under localhost, Typical, and Adverse impairment at
  both 60 and 120 Hz for correction and walk-over regressions;
- a human must play identical scripted scenes side-by-side against clean
  `main`. Automated metrics deliberately cannot declare feel solved alone.

## Deferred scope

Full-world rollback, deterministic lockstep, client prediction of joint graphs,
vehicles, runtime-created/breaking joints, pulley and suspension systems, and
collision-based authority transfer remain out of scope. Jointed contraptions
stay server-only.

Box3D remains pinned. A Rapier or Jolt bake-off starts only if the serialized
cross-runtime conformance trace or measured browser/server budget identifies a
solver defect. The v6 pickup snap and walk-over glitch do not meet that bar;
they were authority, timeline, and presentation defects.
