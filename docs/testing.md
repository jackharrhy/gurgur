# Testing and simulation harnesses

Testing infrastructure is part of Gurgur's production architecture. Every
stateful subsystem ships with deterministic controls, metrics, and a headless
path so correctness and performance can be measured before browser presentation
hides the cause of a failure.

## Test layers

| Layer | Purpose |
| --- | --- |
| Unit | codecs, handles, math, map parsing, controller rules, persistence rows |
| Contract | browser/server codec parity and physics-adapter ownership |
| Simulation | fixed-tick world scenarios with deterministic input scripts |
| Multiplayer | real server with shaped links and many headless clients |
| Browser | rendering, worker prediction, input, interpolation, reconnect |
| Soak | leaks, handle churn, persistence, reset, queue growth, long-run drift |

Tests use original compact fixtures and fixed random seeds. A failure report
includes the seed, build revision, map revision, world epoch, network profile,
server tick, client ID, and the metric samples needed to replay it.

## Regression fixture policy

Every player-visible controller or networking failure becomes a named regression
at the lowest layer that can reproduce it and at one real-browser layer. The
lower test uses the production fixed-step controller, production map bundle or a
minimal authored map, exact runtime body shapes, and an explicit tick script. It
settles bodies before measuring them and asserts spatial bounds throughout the
failure window, not only the final position.

Browser regressions run the real Bun server, WebSocket codec, prediction worker,
Box3D Wasm, Three.js renderer, and browser input path. They sample the rendered
pose on `requestAnimationFrame`, keep authoritative, predicted, and rendered
poses separate, and fail on collision tunnelling, repeated display frames,
prediction-budget violations, stale immutable map URLs, or browser errors.
Headless simulation is never accepted as evidence for visual smoothness by
itself.

Concrete cases live under the subsystem that owns the invariant. The current
dynamic-support regression drops a player onto `physics.cube.heavy` from the
production Systems Garden bundle, waits for both authority and prediction to
settle on the body, jumps, and verifies the player lands on the same support.
The minimal `content/maps/fixtures/network-boxes.map` fixture separately drives
sustained pushing and stacked-box jump scripts through the real authority and
predictor with delayed sparse snapshots. Those tests record authority-to-
prediction player error, body error, grounded disagreement, and collision
penetration throughout the script.

The `dynamic-push` browser scenario samples the actual rendered capsule and
rendered heavy cube on `requestAnimationFrame` under 150 ms simulated RTT. It
requires visible cube response and fails if the presented capsule enters the
cube by more than 3.5 cm. Run it with `bun run smoke:push`; run dynamic support
with `bun run smoke:dynamic`, and the ordinary shaped-link path with
`bun run smoke:latency`.

This policy follows the useful parts of Crashcat's named KCC bug fixtures and
stress scene, Bongle's fixed-tick controller/environment scripts, and Bongle's
separate fixed-pose/render interpolation tests. Fixtures remain original to
Gurgur and exercise Gurgur's selected Box3D runtime and server authority.

## Multiplayer harness

The harness launches the real Bun server and at least 16 concurrent clients. A
headless client uses the production packet unions, binary codecs, clock
estimator, input history, controller, prediction, reconciliation, and snapshot
interpolator. It omits rendering and audio only. Browser scenarios replace
selected headless clients with real browser pages against the same server.

Each direction of each client connection receives an independently seeded link
profile. Because gameplay uses ordered reliable WebSockets, simulated loss adds
retransmission delay and head-of-line stalls rather than silently dropping an
application packet. The link model also applies latency, jitter, bandwidth,
temporary outages, and receiver backpressure.

The baseline world contains 16 moving players, at least 128 replicated dynamic
bodies, sleeping/waking bodies, sensors, grabs, a moving platform, reconnects,
and a global reset. Tests assert both individual behavior and aggregate server
headroom.

## Network profiles

| Profile | RTT | Jitter | Simulated loss | Bandwidth |
| --- | ---: | ---: | ---: | ---: |
| Local | 2 ms | 0 ms | 0% | unlimited |
| Typical | 80 ms | 20 ms | 1% | 10 Mbit/s |
| Adverse | 150 ms | 40 ms | 5% | 1 Mbit/s |
| Constrained | 250 ms | 80 ms | 8% | 256 Kbit/s |

The 16-client suite mixes profiles in one world instead of assigning one global
latency. Outage cases pause a selected link for five seconds and then restore it.
Every profile is deterministic from its seed.

## Quality budgets

Raw reconciliation error is measured before the 100 ms render-offset decay and
includes scripted direction changes. A 60 Hz player at the 5 m/s speed cap moves
8.33 cm per tick, so a sub-tick global threshold would reject correct quantized
behavior. The deterministic profile budgets are therefore:

| Profile | Prediction p95 | Prediction p99 | Prediction max | Snapshot age p95 |
| --- | ---: | ---: | ---: | ---: |
| Local | 10 cm | 25 cm | 50 cm | 100 ms |
| Typical | 10 cm | 50 cm | 1.0 m | 200 ms |
| Adverse | 1.0 m | 1.25 m | 1.5 m | 450 ms |

The Adverse raw bounds explicitly capture the selected ordered-WebSocket tradeoff:
a retransmission stall can make current steering differ from the last intent the
authority received. Constrained is a saturation/recovery profile, not a movement
quality target; it must remain bounded, avoid correctness failures, and recover
after the impairment clears.

Additional gates are:

- local-contact simulation tracks authority within 1 cm for sustained pushing,
  within 6 cm for stacked support/jump scripts, and keeps measured predicted
  collision penetration below 6 mm in the minimal fixture;
- presentation collision is measured independently from simulation divergence;
  the shaped-RTT browser push regression allows at most 3.5 cm including the
  controller skin/tolerance;

- the 60 Hz server tick stays below 8 ms p95 and 12 ms p99 with 16 clients and
  the baseline dynamic world;
- input acknowledgement stays below 200 ms Local, 350 ms Typical, and 1,100 ms
  Adverse at p95;
- remote interpolation extrapolates fewer than 1% of rendered samples on Typical
  with the selected 150 ms interpolation delay;
- the real-browser held-input scenario at 300 ms RTT converges below 5 cm and
  does not repeat more than 25% of sampled display frames;
- no application queue is unbounded, and state backpressure retains only the
  newest unsent snapshot;
- after a five-second impairment, snapshot age and prediction error return to
  the affected profile budget within one second;
- reset/reconnect leaves no old-epoch command, interpolation sample, predicted
  state, voice signal, or runtime handle active.

Reports are emitted as versioned JSON plus a concise terminal summary. CI fails
on correctness errors and budget regressions. Intentional budget changes require
a decision record or an updated canonical requirement, never a looser assertion
hidden in a test.

## Continuous execution

Fast unit, production-map collision regressions, and two-client simulation tests
run on every change. The mixed
16-client network suite runs for networking, physics, controller, persistence,
and protocol changes. Browser prediction/interpolation scenarios run in Chromium
on every such change and in Firefox/WebKit before a release. Long physics,
connection-churn, persistence, and voice tests run as scheduled soaks.
