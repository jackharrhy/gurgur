# Testing

`bun run check` runs format verification, lint, TypeScript, unit/simulation/
integration tests, persistence/content tests, and real protocol-v7 server
transport tests.

## Commands

- `bun run test:network` runs the 16-player/128-body release matrix.
- `bun run test:network --quick` runs six clients for development.
- `bun run test:network stress` reports 32 players/256 bodies nonblocking.
- `bun run test:browser` runs real Chrome movement, pickup/release, contention,
  and jointed contraption scenarios.
- `bun run test:browser movement|pickup|contention|contraption` selects one.
- Pickup runs localhost, Typical, and Adverse flick-and-release scenarios;
  `SMOKE_PROFILE=local|typical|adverse` selects one. Release and prediction traces
  are saved under `reports/browser/`.
- `bun run test:browser capture` runs the full 15-second paired debug capture,
  downloads it, decompresses it, and validates both timelines.

Run wall-clock performance gates without another CPU-heavy suite in parallel.

Profiles use real Bun, `werift`, browser-compatible unordered data channels, and
seeded impairment:

| Profile |    RTT | Jitter | Loss |
| ------- | -----: | -----: | ---: |
| Local   |   2 ms |   0 ms |   0% |
| Typical |  80 ms |  20 ms |   1% |
| Adverse | 150 ms |  40 ms |   5% |

The matrix drives separate production presentation buffers at 60 and 120 Hz.
Their clock is anchored before simulated inbound delay, and packet deliveries
and render samples are processed chronologically.

## Proof hierarchy

A transport packet, an advancing mesh, and a plausible physical interaction are
different claims and require different oracles.

1. Codec tests prove protocol-v7 bounds, four-command ordering/redundancy,
   checkpoints with and without a held body, delta baselines, resend, rollover,
   finite fields, and truncation rejection.
2. The server-player queue test injects duplicate redundant bundles and a
   16-command late burst. Bun must consume the newest intent in the current
   tick, drain the backlog, keep acknowledgements monotonic, and execute each
   recovered action edge once.
3. Independent Bun/browser adapters start from the same state and replay the
   same command stream through `stepPlayerController`, `stepPropGrab`, Box3D,
   60 Hz, and four substeps. Player, held-body, and held-plus-two-loose-body
   contact-island pose/velocity traces must agree within `1e-4` metres/radians
   before network correction.
4. Pickup simulation proves target speed and body acceleration are bounded: a
   distant target cannot be reached in one fixed step.
5. Walk/stand/cross simulation uses the newest loose-body collision pose and
   permits at most 1 cm penetration and two grounded transitions. A focused
   game test requires Source-style release when the held body becomes support;
   another proves a live held-body contact outranks nearer loose candidates in
   the bounded checkpoint set.
6. Physics adapter tests cover wall contact, slopes, steps, crouch clearance,
   moving supports, dynamic reaction impulses, mass-independent target drive,
   stacked/compound bodies, joints, sensors, and deterministic replay.
7. Real server/WebRTC tests prove Bun-owned players, input-bundle delivery,
   checkpoints/acks, first-wins loose claims, adjacent-tick held and released state, bounded release,
   reset, and server-only contraption manipulation.
8. Presentation tests prove source-tick interpolation, per-track adaptive delay,
   no extrapolation, and monotonic delay changes. The prediction trace recorder
   retains input/ack/replay/contact/support metadata plus authoritative,
   collision, predicted, and rendered poses. A server recorder independently
   captures 900 authoritative 60 Hz frames and stops cleanly on world reset,
   player loss, or shutdown.
9. Real Chrome tests exercise production Wasm, workers, input, reconciliation,
   WebRTC impairment, Three.js/WebGPU, contention, and jointed objects. Fast
   flick-and-release motion is traced for 1.5 seconds, then the settled body's
   predicted and rendered poses must converge within 1 cm of authority.
   Equal source ticks alone do not imply equal inputs: Bun consumes newest
   delivered intent while the browser predicts pending commands. Exact physics
   parity is checked with identical command streams in the adapter tests.
   A main-thread stall must not discard worker time; a worker stall must be
   measured.
10. Side-by-side manual play against clean `main` remains required. Metrics can
    reject known bad feel but cannot prove the absence of every perceptual flaw.

## Release budgets

The release matrix requires zero stale authority/correctness errors, Typical and
Adverse state age below 200/300 ms, analytic presentation error below 2/5 cm,
buffer underrun below 0.1%/1%, average state traffic below 2 Mbit/s per
recipient, no discarded host time, and host tick below 8 ms p95 / 12 ms p99.

Browser behavior gates require:

- local movement begins within one predicted fixed tick and presentation is not
  forced behind the Adverse buffer;
- a confirmed pickup creates a predicted dynamic body and begins physical
  movement without a mesh teleport;
- the released body's prediction and presentation converge within 1 cm after
  its motion settles;
- no pickup or release frame discontinuity exceeds the physical 25 cm gate,
  including loss while a recently released body remains on its 60 Hz hot path;
- look changes affect the held physical body within the bounded input/worker/
  render path, rather than waiting for RTT;
- localhost remote motion remains smoothly buffered;
- active localhost render delay settles to at most five ticks;
- two-player contention has one winner and recovers after release/disconnect;
- joint-connected manipulation remains Bun-owned and does not enter prediction.

Run localhost, Typical, and Adverse profiles at 60 and 120 Hz when changing
prediction or presentation policy. Inspect the four-timeline trace for any
walk-over or correction regression.

## Capturing a real feel failure

Open the development game with `?debug`, wait until input is ready, then click
**record 15s** or press `F8`. Reproduce one problem at a time during the entire
countdown. The page automatically downloads `gurgur-physics-*.json.gz`; attach that
file with a screen recording and a short note naming the action and approximate
time of the failure. If automatic download is blocked, use **download last
trace** in the debug panel.

The artifact is the correlation oracle, not a passing test by itself. Compare
frames by server/source tick and input acknowledgement. For each relevant object,
inspect authoritative → collision → predicted → rendered divergence in that
order. A server/client mismatch implicates shared simulation or command replay;
collision/render separation implicates interaction presentation; a correction
spike with growing replay count implicates transport/checkpoint recovery. The
capture includes the page URL and user agent plus gameplay inputs/transforms, so
review it before sharing outside the project.

## Physics replacement gate

Box3D remains selected. A candidate must consume the same serialized initial
state and inputs and report per-tick pose/velocity, controller result,
contact/support IDs, constraint error, maximum penetration, sleep behavior, and
finite-state checks in Bun and a real browser. A solver replacement is justified
only by failure of that conformance artifact or measured runtime constraints;
it cannot repair an authority, timeline, or presentation defect.
