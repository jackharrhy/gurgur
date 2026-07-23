# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-07-23.

## Current state

The authoritative multiplayer replacement is complete as an end-to-end vertical
slice:

- one Bun process owns the persistent 60 Hz Box3D world, serves HTTP and reliable
  WebSocket control, and terminates per-client WebRTC gameplay channels;
- protocol v2 sends redundant 60 Hz newest-wins intent and 30 Hz self-contained
  quantized state datagrams; current state is dropped under backpressure rather
  than queued behind obsolete state;
- players send intent only. Loose props, stacks, dominoes, constraints, grabs,
  sleep, persistence, and interaction outcomes exist only in the server world;
- the browser restores and replays only its geometric player controller.
  Authoritative moving bodies are kinematic collision proxies, never locally
  simulated rigid-body truth. Prop motion extrapolates for at most 100 ms, while
  collision expires only after 100 ms of real client time without an update;
- per-client 1,200-byte interest selection reserves four closest-prop slots,
  rotates other near/far state, repeats terminal sleep, and includes the local
  player, twelve nearest remotes, and three rotating far remotes;
- independently sorted per-body tracks accept reordered sparse samples, adapt
  presentation delay from 100 to 250 ms, and cap velocity extrapolation at
  100 ms;
- TrenchBroom Valve 220 fixtures now cover light/heavy corridor pushes, stacked
  support and sleep propagation, and domino wake/contact chains in addition to
  the original network boxes;
- browser smokes exercise the real server, WebSocket signaling, WebRTC channels,
  prediction worker, Box3D Wasm, and Three.js presentation.

The existing compiler, entity schema, mechanisms, persistence, browser input,
render pipeline, and content-authoring surfaces remain in place. Canonical
networking and physics documents and AGENTS invariants were revised where the
former dynamic-prop prediction design was unsound.

`werift@0.23.0` remains pinned. Its packet-lifetime defect is not vendored or
patched; state uses its working one-retransmission policy and the application
still drops buffered snapshots. Its transitive `ip@2.0.1` audit advisory is
accepted without a shim or unrelated replacement, as recorded in decision 0012.

## Executable evidence

`bun run check` owns formatting, lint, types, unit/contract/simulation tests,
real-server integration, and shutdown/configuration. The real network matrix
owns 2, 8, 16, and 32 WebRTC peers, 128 dynamic bodies, Local/Typical/Adverse
quality paths, a deliberately saturated Constrained path, a five-second outage,
a receiver stall, and a connected epoch reset.

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
bun run soak:physics
bun run soak:persistence
bun run soak:connections
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
bun run harness:matrix
bun run smoke:browser
bun run smoke:latency
bun run smoke:dynamic
bun run smoke:push
bun run smoke:grab
bun run smoke:touch
bun run smoke:gamepad
bun run smoke:reconnect
bun run soak:physics
bun run soak:persistence
bun run soak:connections
```
