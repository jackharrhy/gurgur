# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-07-23.

## Current state

The production foundation exists end to end but is not release-complete:

- one Bun process serves the vanilla Three.js app, native gameplay WebSocket,
  authoritative 60 Hz Box3D world, strict SQLite persistence, administration,
  health/readiness/metrics, and revision-addressed immutable map assets;
- the Valve 220 compiler validates the typed entity schema, preserves source and
  UV identity, emits deterministic binary geometry, supports multi-brush moving
  bodies, and hashes the result as `mapRevision`;
- protocol v1 has bounded exact JSON control unions and explicit binary input,
  snapshot, and lifecycle codecs, including multi-brush lifecycle identity;
- local player and nearby dynamic-body prediction/replay, collision-clamped
  display correction, 250 ms unrelated-remote interpolation, movement-event
  dirty replication, generation-safe reconnect, and epoch reset run through the
  real browser/server path;
- doors, platforms, buttons, triggers, relays, delayed signals, grabs, player
  controller state, sleep state, and cooldown/latch state survive clean-start
  tick-boundary snapshots and process restart;
- the browser play view is canvas-only with no HUD, reticle, visible cursor,
  control overlay, voice client, or voice signaling surface;
- keyboard/mouse and gamepad movement/jump/use/grab paths are wired; touch keeps
  HUD-free canvas movement and look gestures;
- pre-release entity/compiler/persistence compatibility machinery is removed;
  wire and world-bundle boundaries expose one exact v1 contract;
- the WebGPURenderer/TSL presentation renders through a 480 x 270
  nearest-neighbour, palette-quantized `RenderPipeline` with vertex-stage Gouraud
  lighting, vertex snapping, partially affine mapping, mip-stable animated pixel
  materials, billboard players, and map-authored decorative sprites.

## Executable evidence

`bun run check` covers the fast/contract tests plus real-server integration and
shutdown/configuration tests. The browser commands cover ordinary movement,
300 ms RTT prediction, dynamic-body landing, grab, HUD-free touch navigation,
gamepad, and stale-session recovery. Failures retain browser state and screenshots.

The deterministic network matrix runs real child-process authority with 2, 8,
16, and 32 clients, 128 dynamic bodies, independently shaped ordered links,
five-second outage, receiver stall, connected reset, per-profile metrics, and
canonical budget gates. Reports are generated under ignored `reports/` paths and
retained only while diagnosing a regression.

The 2026-07-22 network-quality slice passes the complete deterministic matrix with
zero correctness errors. The final gated 16-client run measured server ticks at
1.68 ms p95 and 2.43 ms p99. Typical measured effectively zero prediction error
at p95, 0.25 m p99/max, 71.9 ms snapshot age p95, 243.9 ms acknowledgement p95,
and 0.46% extrapolation. Adverse measured 0.83/1.08/1.33 m prediction p95/p99/max,
136.7 ms snapshot age, and 415.7 ms acknowledgement. Five-second outage and
receiver-stall clients recovered to effectively zero prediction error with
1.0 ms and 79.5 ms snapshot age, respectively, inside the one-second recovery
window.

The mixed aggregate remains intentionally diagnostic rather than a quality gate:
its large prediction and snapshot-age tail is dominated by continuously saturated
Constrained clients. Harness terminal summaries now separate Local/Typical/Adverse
quality profiles from that 256 Kbit/s saturation profile. Unrelated dirty bodies
replicate at a staggered 10 Hz while players and five-metre prediction state remain
20 Hz; the remote presentation buffer is 250 ms. The authored push/stack and
browser presentation regressions continue to own the local-contact gates.

Scheduled soaks are first-class commands:

```sh
bun run soak:physics      # 10,000 handle cycles; 1,000,000 fixed ticks
bun run soak:persistence  # 10,000 transactional save/load cycles and reopen
bun run soak:connections  # 1,000 same-session replacements with epoch resets
```

One-off decision experiments and superseded plans have been removed. Their durable
conclusions live in `docs/decisions/`, canonical documents, and focused production
tests.

## Active focus

- Extend the local-contact region from a distance-bounded set to an explicit
  contact-connected island if authored mechanisms create cases where five metres
  includes too much unrelated dynamic work or excludes a coupled body.
- Continue decomposing lifecycle owners only where a smaller capability boundary
  appears. Seven TypeScript classes remain after converting browser input to a
  lexical factory and deleting voice. Five directly guard external resources or
  durable queues; the broad
  `AuthoritativeGame` and `PlayerPredictor` coordinators remain the concrete
  decomposition targets. The cleanup already split map verification,
  runtime-body construction, and mechanism/signal state out of the authority,
  and replaced interpolation/presentation constructors with plain-data factories.
- Treat the entity schema, generated FGD, map compiler, and production map tests
  as the stable content-authoring surface while controller/network work continues.
- Replace the player billboard harness's directional placeholder with final
  character art, then extend its marker/atlas contract with animation rows.

## Release/environment gates

These are release checks rather than undecided architecture:

- run the browser suite in Firefox and WebKit on CI hardware that has those
  engines installed;
- build the Docker image, run it with a mounted `/data` volume, exercise HTTP,
  WebSocket, metrics, authenticated reset, restart restore, and SIGTERM on the
  target container runtime.

## Commands

```sh
bun run check
bun run build
bun run setup:player-harness
bun run render:player
bun run harness:matrix
bun run smoke:browser
bun run smoke:latency
bun run smoke:dynamic
bun run smoke:push
bun run smoke:grab
bun run smoke:touch
bun run smoke:gamepad
bun run smoke:reconnect
```
