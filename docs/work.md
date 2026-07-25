# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-07-25.

## Current state

The authoritative multiplayer replacement is complete as an end-to-end vertical
slice:

- one Bun process owns the persistent 60 Hz Box3D world, serves HTTP and reliable
  WebSocket control, and terminates per-client WebRTC gameplay channels;
- protocol v2 sends redundant 60 Hz newest-wins intent with selective state
  receipt acknowledgement and 30 Hz self-contained quantized state datagrams;
  current state is dropped under backpressure rather than queued behind obsolete
  state;
- players send intent only. Loose props, stacks, dominoes, constraints, grabs,
  sleep, persistence, and interaction outcomes exist only in the server world;
- the browser restores and replays only its geometric player controller.
  Prediction history is indexed by a server-disciplined tick estimate, so neither
  input acknowledgement cadence nor quantized browser timer callbacks can
  manufacture or remove fixed simulation steps. Authoritative moving bodies are
  kinematic collision proxies, never locally simulated rigid-body truth. Prop
  motion extrapolates for at most 100 ms, while collision and current-contact
  presentation share the same real-time freshness expiry;
- per-client 1,200-byte interest selection keeps delivery history: interaction
  and recent-release state uses a fast lane, nearby awake state has a bounded
  deadline, accumulated importance prevents starvation, and terminal sleep uses
  a capped lane until selectively acknowledged. Player selection still includes
  the local player, twelve nearest remotes, and three rotating far remotes;
- independently sorted per-body tracks accept reordered sparse samples, adapt
  presentation delay from 100 to 250 ms, and cap velocity extrapolation at
  100 ms;
- TrenchBroom Valve 220 fixtures now cover light/heavy corridor pushes, stacked
  support and sleep propagation, and domino wake/contact chains in addition to
  the original network boxes;
- prop pickup uses a camera-forward, obstruction-aware target controller with
  mass-scaled bounded impulses and yaw-relative angular stabilization instead of
  the former fixed-length orbiting distance joint;
- regular typed triggers now send paired `play`/`stop` outputs to
  `ambient_audio` nodes by compiled entity index, with listener-local overlap
  priority, crossfades, logical MP3 assets, and no new transport or persistence
  state;
- hard reloads now preserve the per-tab socket-generation sequence alongside
  the resumable session token, preventing progressively slower stale-generation
  reconnect loops;
- the play canvas remains black until a predicted local-player pose has actually
  driven a rendered camera frame, eliminating the initial default-camera flash;
- `GURGUR/SKIP` is a generated transparent TrenchBroom face tag whose compiled
  faces remain authoritative collision while being absent from static and moving
  brush presentation;
- static and moving brush presentation now front-face culls the compiler's
  outward triangle winding in both retro and reality passes;
- the predicted third-person view now uses a collision-tested camera boom that
  respects static `GURGUR/SKIP` boundaries and kinematic brush mechanisms,
  retracts immediately, and recovers outward with held frame-rate-independent
  damping;
- browser smokes exercise the real server, WebSocket signaling, WebRTC channels,
  production input scheduler, prediction worker, Box3D Wasm, and Three.js
  presentation. The required `bun run check` gate includes a long-lived Chromium
  clock-drift reproduction;
- the non-production `?debug` view can deliberately record at most 15 seconds of
  side-effect-free 60 Hz authority, exact selected/quantized outbound state,
  input receipt, prediction/reconciliation, clock, and final presentation into
  one schema-versioned `.gurgur-trace.json` with embedded aligned analysis;
  production exposes no capture capability or mutation routes.

The repository is consolidated around `apps/server`, `apps/web`,
`packages/engine`, and `packages/game`. The typed catalog compiles mapper
classnames into a closed game-owned union; engine, renderer dispatch, and
transport use capabilities or immutable bundle indices instead of classnames.
World settings/spawns/reset markers are partitioned, persistence has one strict
game-state document beside structured world/body/player tables, and content,
browser, network, and soak commands are grouped behind four discoverable
dispatchers.

`werift@0.23.0` remains pinned. Its packet-lifetime defect is not vendored or
patched; state uses its working one-retransmission policy and the application
still drops buffered snapshots. Its transitive `ip@2.0.1` audit advisory is
accepted without a shim or unrelated replacement, as recorded in decision 0012.

## Executable evidence

`bun run check` owns formatting, lint, types, unit/contract/simulation tests,
real-server integration, shutdown/configuration, and one real Chromium-to-Bun
prediction clock gate. The real network matrix owns 2, 8, 16, and 32 WebRTC
peers, 128 dynamic bodies, Local/Typical/Adverse quality paths, a deliberately
saturated Constrained path, a five-second outage, a receiver stall, and a
connected epoch reset.

The final 2026-07-23 seeded matrix passed every gate with zero correctness errors,
zero state drops, zero queued state bytes, and zero contact-proxy extrapolation
overruns. The gated 16-client run measured:

| Profile | Prediction p95/p99/max  | State age p95 | Input ack p95 |
| ------- | ----------------------- | ------------- | ------------- |
| Local   | 0.235 / 0.350 / 0.360 m | 1.0 ms        | 33.4 ms       |
| Typical | 0.457 / 0.540 / 1.487 m | 72.5 ms       | 121.3 ms      |
| Adverse | 1.573 / 1.835 / 1.881 m | 135.8 ms      | 199.1 ms      |

At 16 peers the server tick cost was 2.47 ms p95 and 4.06 ms p99. At 32
peers it was 3.94 ms p95 and 5.18 ms p99, still with no transport queue or
server-side state drop. After the five-second partition, the affected client
recovered to 0.0001 m prediction correction p95 and 1.0 ms state age p95 in the
final second. Receiver-stall recovery was 0.535 m and 74.4 ms. Connected reset
ended on the new epoch at 0.256 m and 68.0 ms, with no stale input, tracks, or
handles.

The 2026-07-25 protocol-v2 prediction/scheduling replacement passed
`bun run check`, the real browser grab smoke, the 16-client mixed profile, and
the 2/8/16/32-peer quick matrix including outage, receiver stall, and connected
reset. The 16-client mixed run had zero correctness errors, state drops, queued
bytes, or contact-proxy overruns; its Local/Typical/Adverse prediction p95 was
0.108/0.084/0.452 m respectively. The focused independently phased no-contact
regression remains stricter at 0.005/0.01/0.02 m p95/p99/max and the saturated
grab-carry-turn-release test round-trips production codecs with 32 competing
bodies.

A later real Chromium trace exposed that its nominal 60 Hz interval produced
intent at 62.27 Hz while the server held 59.99 Hz. Callback-clocked prediction
therefore accumulated 63 replay ticks and reached 4.75 m of local presentation
error. The replacement real-browser gate failed the old path at 1.0833 m after
6.5 seconds, then passed the server-disciplined path at 60.00 Hz, zero accumulated
tick lead, and 0.0833 m ordinary moving lead. That Chromium-to-Bun scenario is
now part of `bun run check`, not an optional smoke invoked only after unit tests.

The map/prediction regressions additionally prove that only the authority moves
props, latest intent replaces stale queued intent, action counters survive loss,
terminal sleep repeats, persistence/reset preserve identity rules, stale contact
proxies stop after six ticks, moving support remains usable, and current
player/prop presentation does not create the old temporal overlap seam. Physics
event extraction also drops post-destruction Box3D events rather than resolving
them through a recycled runtime slot. Prediction treats a state blackout over
500 ms as a discontinuity, applies its incoming fresh prop state after clearing
stale proxies, and shares the server's rejection of implausible single-tick
controller motion. Every sparse body sample in a render batch reaches prediction
even though player reconciliation runs only for the newest state. Input does not
arm until the WebRTC state path has delivered current authority.
Players that fall ten metres below authored static collision respawn
authoritatively instead of accumulating an unbounded below-map fall. Teleport
markers repeat for one second so a disposable state loss cannot hide the
respawn discontinuity.

Scheduled soaks remain first-class commands:

```sh
bun run soak -- physics
bun run soak -- persistence
bun run soak -- connections
```

## Active focus

There is no remaining undecided networking ownership model. Follow-up work is
deployment and breadth:

- supply and validate production STUN/TURN configuration and the bounded UDP
  range on the target host rather than assuming loopback/direct ICE reachability;
- run the browser suite in Firefox and WebKit on CI hardware with those engines;
- run the Docker image with a mounted `/data` volume through HTTP, WebSocket,
  WebRTC, reset, restart restore, and SIGTERM on the target container runtime;
- extend long-duration soak coverage when production concurrency and map density
  targets are known;
- replace the player billboard harness placeholder with final character art and
  animation rows.

## Commands

```sh
bun run check
bun run build
bun run content -- compile
bun run test:network -- matrix
bun run test:browser -- all
bun run soak -- physics
bun run soak -- persistence
bun run soak -- connections
```
