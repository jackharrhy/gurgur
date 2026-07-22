# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-07-22.

## Current state

The production foundation exists end to end but is not release-complete:

- one Bun process serves the vanilla Three.js app, native gameplay WebSocket,
  authoritative 60 Hz Box3D world, strict SQLite persistence, administration,
  health/readiness/metrics, and revision-addressed immutable map assets;
- the Valve 220 compiler validates the typed entity schema, preserves source and
  UV identity, emits deterministic binary geometry, supports multi-brush moving
  bodies, and hashes the result as `mapRevision`;
- protocol v6 has bounded exact JSON control unions and explicit binary input,
  snapshot, and lifecycle codecs, including multi-brush lifecycle identity;
- local prediction/replay, display-frame smoothing, 150 ms remote interpolation,
  movement-event dirty replication, generation-safe reconnect, and epoch reset
  run through the real browser/server path;
- doors, platforms, buttons, triggers, relays, delayed signals, grabs, player
  controller state, sleep state, and cooldown/latch state survive schema-v5
  tick-boundary snapshots and process restart;
- proximity voice has an authoritative symmetric six-peer graph, WebRTC Opus
  media, HRTF spatialization, STUN/TURN configuration, relay-only mode, blocking,
  gain mute, permission/device-loss isolation, peer churn, and epoch teardown;
- keyboard/mouse, touch, and gamepad movement/jump/use/grab paths are wired.
- the WebGPURenderer/TSL presentation renders through a 480 x 270
  nearest-neighbour, palette-quantized `RenderPipeline` with vertex-stage Gouraud
  lighting, vertex snapping, partially affine mapping, mip-stable animated pixel
  materials, billboard players, and map-authored decorative sprites.

## Executable evidence

`bun run check` covers 81 fast/contract tests plus eight real-server integration
and shutdown/configuration tests. The browser commands cover ordinary movement,
300 ms RTT prediction, dynamic-body landing, grab, touch, gamepad, stale-session
recovery, and six-page voice. Failures retain browser state and screenshots.

The deterministic network matrix runs real child-process authority with 2, 8,
16, and 32 clients, 128 dynamic bodies, independently shaped ordered links,
five-second outage, receiver stall, connected reset, per-profile metrics, and
canonical budget gates. Reports are generated under ignored `reports/` paths and
retained only while diagnosing a regression.

The 2026-07-22 cleanup baseline completed a mixed-profile 16-client run with zero
correctness errors and 2.08 ms server-tick p95, but it is not a movement-quality
pass: aggregate prediction error was 0.50 m p95, 1.95 m p99, and 7.28 m maximum,
with 34.5% extrapolated presentation samples. These numbers keep netcode quality
as active work even though the authority remained bounded.

Scheduled soaks are first-class commands:

```sh
bun run soak:physics      # 10,000 handle cycles; 1,000,000 fixed ticks
bun run soak:persistence  # 10,000 transactional save/load cycles and reopen
bun run soak:connections  # 1,000 same-session replacements with epoch resets
bun run soak:voice        # 20 six-browser WebRTC enable/disable cycles
```

One-off decision experiments and superseded plans have been removed. Their durable
conclusions live in `docs/decisions/`, canonical documents, and focused production
tests.

## Active focus

- Reproduce sustained lateral player pressure against dynamic boxes at both the
  controller and real-browser layers. The current landing regression does not
  cover the reported case where the predicted or authoritative capsule phases
  into a pushed body.
- Use that fixture to separate controller collision, dynamic-body impulse,
  prediction-proxy synchronization, and snapshot presentation errors before
  changing movement constants.
- Finish the mixed-profile multiplayer gates for correction recovery, receiver
  stalls, reconnect, and epoch reset. Keep the deterministic link model and real
  server/client harness; do not rebuild these as mocks.
- Continue decomposing lifecycle owners only where a smaller capability boundary
  appears. The cleanup split map verification, runtime-body construction, and
  mechanism/signal state out of the authoritative coordinator, and replaced
  interpolation/presentation constructors with plain-data factories.
- Treat the entity schema, generated FGD, map compiler, and production map tests
  as the stable content-authoring surface while controller/network work continues.

## Release/environment gates

These are release checks rather than undecided architecture:

- run the browser suite in Firefox and WebKit on CI hardware that has those
  engines installed;
- run relay-only voice against the deployment TURN service and verify the selected
  candidate pair is relay-only (local tests validate configuration and direct
  six-peer media; no TURN service or credentials are stored in this repository);
- build the Docker image, run it with a mounted `/data` volume, exercise HTTP,
  WebSocket, metrics, authenticated reset, restart restore, and SIGTERM on the
  target container runtime.

## Commands

```sh
bun run check
bun run build
bun run harness:matrix
bun run smoke:browser
bun run smoke:latency
bun run smoke:dynamic
bun run smoke:grab
bun run smoke:touch
bun run smoke:gamepad
bun run smoke:reconnect
bun run smoke:voice
```
