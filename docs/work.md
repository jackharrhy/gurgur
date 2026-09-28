# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-09-28.

## Flick-and-release investigation

The September audit found and repaired several independent sources of prop
glitches:

- Held/released 60 Hz state was deferred for a whole tick, allowing the next
  publication to overwrite it. Sending after the current simulation turn
  preserves the hot cadence; a real WebRTC regression failed before the fix.
- Local replay results were incorrectly rejected as duplicate or older network
  samples. Local results now replace prediction; authoritative samples remain
  monotonic across independent checkpoint and cluster delivery.
- Equal-acknowledgement checkpoints could arrive out of order and restore old
  physics. Worker admission now checks server tick and authority generation.
- Collision proxies could remain on replay-time poses after reconciliation.
  They now return to the newest authoritative state before live prediction.
- Correction smoothing counted ordinary movement as error, ignored centimetre
  and rotation-only corrections, and could apply a release offset after an
  intermediate clamp in the wrong direction. Correction uses actual replay
  deltas and caps only the final release-transition pose.
- Immediate prop rendering could combine two valid physics ticks into one
  visible jump. [Decision 0026](decisions/0026-predicted-prop-presentation.md)
  adds one-tick interpolation for predicted props using normalized worker
  production timestamps; player presentation remains immediate.
- Remote walking players were classified inactive because their packet has no
  horizontal velocity. Their render tracks now adapt to measured latency; the
  deterministic Adverse regression improved from 15/49 to 49/49 advancing frames.

Browser pickup now covers stronger flicks under localhost, Typical, and Adverse
impairment with 1.5-second release traces and settled convergence. Identical
source ticks are no longer used as a false identical-input physics oracle;
the independent shared-controller traces retain that proof.

Validation, 2026-09-28:

- `bun run check`: formatting, lint, typecheck, and all 198 tests pass.
- `bun run test:browser`: all scenarios pass. The three flick profiles record
  91 release frames each at approximately 60 Hz; maximum steps are
  15.38/8.04/8.78 cm for Local/Typical/Adverse, below the unchanged 25 cm gate.
- `bun run test:browser capture`: paired 15-second diagnostic download passes.
- `bun run test:network`: 16 players and 128 bodies pass all profiles with zero
  correctness errors, discarded host time, or measured buffer underruns;
  100% moving-oracle frame advancement at 60 and 120 Hz; approximately
  0.82 Mbit/s per recipient; host tick p95/p99 of 2.32/3.58 ms.
- Focused presentation tests exercise interpolation and reconciliation at both
  60 and 120 Hz. The real Chrome display in this environment ran at 60 Hz.

Follow-up defects found outside the flick/release path:

- Ordinary void respawn resets state sequence without the documented authority
  increment/reliable discontinuity; preserve command sequence when fixing it.
- Gravity-field prediction restores the player's default gravity factor before
  replay when its proxy is recreated. Checkpoint gravity restoration needs a
  focused field-crossing regression.

Manual side-by-side play against the reference remains outstanding. Automated
tests cannot certify the absence of every perceptual flaw.

## Current state

Protocol v7 implements the Source-style recovery selected by
[decision 0024](decisions/0024-source-style-networked-physics.md) and the
bounded contact-island refinement in
[decision 0025](decisions/0025-bounded-contact-island-prediction.md):

- Bun simulates every player and shared rigid body at 60 Hz with four substeps;
- browsers send four-command redundant unordered input bundles and publish no
  player or loose-body gameplay state;
- each browser predicts its local player, one confirmed held loose prop, and a
  stable set of at most four eligible loose bodies within six metres with the same Box3D
  adapter, `stepPlayerController`, and `stepPropGrab` used by Bun;
- Bun sends owner-specific checkpoints at 30 Hz with the last processed command,
  complete player state, bounded nearby loose-body states, and optional
  held-body/grab state;
- browsers retain 128 commands, restore checkpoints, replay unacknowledged
  input, and sample nearby proxy history at each replay source tick;
- Bun treats delivered commands as sampled intent: a late burst acknowledges
  and consumes its newest sample immediately while recovering action edges;
- ordinary collision proxies use newest authoritative state instead of the v6
  fixed eight-tick collision timeline;
- every locally predicted body advances a distinct 60 Hz presentation sequence;
  host samples update correction targets without replacing local tracks;
- held and nearby predicted props render from their dynamic bodies, and
  reconciliation uses visual error decay with a 20 cm body step bound;
- a confirmed grab's release edge is predicted during replay, and extraordinary
  release correction is presentation-rate-bounded instead of teleporting;
- a held prop is released if it becomes the player's support;
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
- per-player deduplication, newest-intent burst recovery, monotonic
  acknowledgement, and single execution of action edges;
- independent Bun/browser Box3D adapters that agree for a player, free held
  prop, and held-plus-two-body contact island within `1e-4` metres/radians for
  the same checkpoint and commands;
- pickup acceleration/velocity gates that forbid one-frame target arrival;
- walk, stand, and cross fixtures using newest loose-body collision poses, with a 1 cm
  penetration and bounded grounded-transition budget;
- server-authoritative pickup, release, contention, disconnect, reset, and
  jointed manipulation through real Bun/WebRTC;
- production Chrome movement, physical pickup/release, same-source-tick
  host/browser held-state agreement, contention, and contraption scenarios;
- a bounded trace with command/ack/replay/contact/support data and
  authoritative, collision, predicted, and rendered transforms;
- a `?debug`/`F8` 15-second capture pairs that browser trace with 900 Bun
  authoritative frames, assembles/compresses off the main thread, and downloads
  one versioned JSON artifact for real gameplay bug reports;
- the 16-player/128-body real transport matrix and existing fixed-step/tick,
  state-age, traffic, underrun, and analytic-presentation budgets.

## Release gate

Automated implementation gate, 2026-08-02:

- `bun run check` passes formatting, lint, TypeScript, and all 182 tests;
- `bun run test:browser` passes movement, physical pickup/release, first-wins
  contention/recovery, and server-only contraption scenarios; the adverse
  pickup path also passed three consecutive isolated runs;
- the 16-player/128-body matrix passes with zero correctness/stale-authority
  errors, zero measured underruns, 100% advancing moving-oracle frames at 60 and
  120 Hz, approximately 0.83 Mbit/s per recipient, and 2.47/3.29 ms host tick
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
