# Research references

Prefer primary source, current source code, and measured local behavior over
secondary summaries. Links below were reviewed on 2026-07-21. Commit hashes make
the inspected code explicit; update the hash and conclusions together.

## Personal prior art

- [`jackharrhy/burger`](https://github.com/jackharrhy/burger), inspected at
  `3318d84fa59cefdb57bb0f2549a08f3c2b642fb2`. Useful for BitECS structure,
  sequenced inputs, queue bounds, acknowledgements, prediction/replay,
  interpolation, protocol tags, and artificial latency controls. Its 2D
  collision, Elysia/auth/editor systems, arrival-time interpolation samples, and
  client-duration movement are not part of Gurgur's design.
- [`jackharrhy/ericw-tools`](https://github.com/jackharrhy/ericw-tools), inspected
  at `de206725d63fcd52a7ff7bd67451949059299712`. Useful for Quake brush/map
  compiler behavior and diagnostics; it is GPL, so treat it as reference unless
  a deliberate compatible reuse decision is made.
- [`jackharrhy/quake-experiments`](https://github.com/jackharrhy/quake-experiments),
  inspected at `8d40580cf360d3dd1edb6652c7f522c22866e1da`. This is a trailhead to
  Quake-related projects, not runtime prior art.

## Bun runtime

- [Bun WebSockets](https://bun.sh/docs/runtime/http/websockets) for native
  `Bun.serve` upgrades, per-connection data, payload limits, send return values,
  backpressure, and drain handling used by the gameplay transport.
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite) for the synchronous built-in
  driver, transactions, prepared statements, strict typing support, and WAL
  configuration used by persistence.
- [Bun bundler](https://bun.sh/docs/bundler) for TypeScript/browser builds, worker
  assets, and Wasm asset handling.
- [Bun full-stack server](https://bun.sh/docs/bundler/fullstack) for importing an
  HTML entrypoint into `Bun.serve`, same-process API routes, development HMR, and
  production asset bundling.

## Box3D and physics

- [Box3D announcement](https://box2d.org/posts/2026/06/announcing-box3d/) and
  [Box3D repository](https://github.com/erincatto/box3d), inspected at
  `23861418d877fdd97990f35645e845e44a7eb9ec` (v0.1.0-era main). These establish
  that Box3D is 3D, C17, Emscripten-buildable, and currently young.
- [Box3D manual](https://box2d.org/documentation3d/) for API concepts and stated
  limitations. The manual warns that its prose is a work in progress.
- [`isaac-mason/box3d.js`](https://github.com/isaac-mason/box3d.js), inspected at
  `72491a34adcf6fc1cf562199d51b3766d5210e9d`, with vendored Box3D revision
  `8441b4a06d6d09dcfb0b0f704df4d847d1437b92`. It is the selected binding: ESM,
  TypeScript declarations, inline/separate Wasm variants,
  and a faithful flat C API. The runtime decision is recorded in
  [`decisions/0001-box3d-runtime.md`](decisions/0001-box3d-runtime.md).
- [`isaac-mason/crashcat`](https://github.com/isaac-mason/crashcat), inspected at
  `959bd0b106136a39cf0d31f6ce4060c818778aab`, for readable pure-TypeScript
  physics, dynamic-BVH queries, KCC/floating-controller experiments, moving
  platforms, contacts, and debug tooling. Use as behavioral prior art, not a
  second production physics engine.
  Its `tst/character/kcc.test.ts` turns concrete controller failures into named,
  fixed-step regression fixtures with settle loops and spatial bounds, while
  `example-kcc-stress-test.ts` exercises 50 controllers, uneven terrain,
  character proxies, respawn bounds, and visual debug output. Gurgur adopts that
  regression/stress split with its own Box3D fixtures.
- [Erin Catto's publications](https://box2d.org/publications/) for sequential
  impulses, constraints, continuous collision, GJK, numerical methods, and broad
  phase fundamentals shared with Box3D's lineage.
- [Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/) for the
  fixed-step accumulator and catch-up limits.
- [It IS Rocket Science!](https://www.gdcvault.com/play/1025341/It-IS-Rocket-Science-The)
  (Psyonix, GDC 2018) for product tradeoffs in a server-authoritative game built
  around networked rigid-body interaction.

## Game networking

- Yahn Bernier, [Latency Compensating Methods in Client/Server In-game Protocol
  Design and Optimization](https://developer.valvesoftware.com/wiki/Latency_Compensating_Methods_in_Client/Server_In-game_Protocol_Design_and_Optimization)
  (2001): authoritative server, user commands, shared movement, prediction,
  acknowledgements, interpolation, and lag-compensation tradeoffs.
- [id Software Quake/QuakeWorld source](https://github.com/id-Software/Quake),
  inspected at `bf4ac424ce754894ac8f1dae6a3981954bc9852d`. In particular, QuakeWorld's
  `cl_input.c` stores commands for prediction and sends redundant prior commands;
  `cl_ents.c` predicts player motion. It is historical GPL source, not a modern
  browser protocol template.
- Glenn Fiedler, [Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation/)
  and [State Synchronization](https://gafferongames.com/post/state_synchronization/)
  for jitter buffers, sequence handling, bandwidth/state tradeoffs, and why
  cross-platform floating-point assumptions need testing.
- [`mas-bandwidth/netcode`](https://github.com/mas-bandwidth/netcode), inspected
  at `c803a6c77d4f77b3a652d60a6cc5534f088d9956`, for a production-minded secure
  connection protocol over unreliable UDP. Its reliability/security machinery
  does not apply to Gurgur's ordered WebSocket transport.
- [Overwatch Gameplay Architecture and Netcode](https://www.gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and)
  (Blizzard, GDC 2017) for a mature ECS and deterministic networked simulation;
  it is inspiration, not evidence that this small project needs the same scale.
- [`isaac-mason/bongle`](https://github.com/isaac-mason/bongle), inspected at
  `0fc560eaf9005b7df488d555379ed683b31a741f`, for fixed ticks versus render
  frames, logic versus visual transforms, server-time interpolation, ownership,
  per-field authority, prediction, and character-controller edge cases. Its
  multi-room voxel-engine model is broader than Gurgur and is not an adoption
  target. In particular, do not import its owner-authoritative movement or treat
  transform blending as input replay/reconciliation.
  Its KCC walking/environment end-to-end tests connect the real controller to
  deterministic worlds and drive exact tick scripts, including regressions for
  previously reported environmental failures. Its render interpolation module
  separately stores prior/current owner transforms for fixed-tick display
  interpolation. Gurgur applies both patterns without adopting Bongle's
  authority model.
- [`isaac-mason/gatho`](https://github.com/isaac-mason/gatho), inspected at
  `775b8e38b4e64c15f7a46072e255cce66cd19c7d`, for shared packet unions,
  reconnect semantics, bounded reliable buffering, backpressure drain tracking,
  protocol versioning, and the useful reliable/unreliable semantic split. Its
  rooms, matchmaking, Redis, and process-per-room architecture conflict with one
  persistent world and are excluded.

## Browser transport

- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
  and [head-of-line blocking](https://developer.mozilla.org/en-US/docs/Glossary/Head_of_line_blocking)
  for the ordered reliable transport and backpressure limitations of the first
  transport.
- [W3C WebTransport](https://www.w3.org/TR/webtransport/) and the
  [MDN WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API)
  establish the reliable-stream and unreliable-datagram model considered and
  rejected by [`decisions/0002-gameplay-transport.md`](decisions/0002-gameplay-transport.md).
- [`geckosio/geckos.io`](https://github.com/geckosio/geckos.io), inspected at
  `d069b53049782bcf75dcc10e6f0891fb2a907db9`, for unordered/unreliable WebRTC
  DataChannels from browser clients to an authoritative server, ICE deployment,
  and dropping stale state under backpressure. It is data-channel networking,
  not voice media, and its native server/deployment surface is excluded from
  Gurgur's selected gameplay transport.
- [MDN WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) and
  [`getUserMedia`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
  for peer connections, audio tracks, secure-context requirements, and explicit
  device permission.
- [LiveKit SFU architecture](https://docs.livekit.io/reference/internals/livekit-sfu/)
  and [selective subscriptions](https://docs.livekit.io/guides/room/receive) for
  the P2P scaling tradeoff and a server-mediated option suitable for spatial
  audio neighborhoods.

## Isaac Mason ecosystem

- [`isaac-mason/navcat`](https://github.com/isaac-mason/navcat), inspected at
  `bc9d3c3f372a9a94cde9c8c2382baa35c1ebd25f`, for a pure-TypeScript,
  serializable navmesh pipeline, tiled updates, areas, links, crowds, and dynamic
  obstacles. Navigation is outside current product scope; this source establishes
  the artifact model if that scope changes.
- [isaacmason.com](https://isaacmason.com/) is the ecosystem index connecting
  Box3D.js, Crashcat, Navcat, Gatho, and Bongle. Treat the projects as a coherent
  source of patterns while evaluating each dependency independently.
- [`isaac-mason/packcat`](https://github.com/isaac-mason/packcat), inspected at
  `0be7cf9dd26befb7640114960ff2c94f1f743d29`, is the binary schema dependency
  used by Gatho and Bongle. Its generated serializers use `new Function`, which
  complicates a strict browser Content Security Policy. Retain JSON-first
  protocol work and evaluate/fuzz a binary codec only after measuring the need.

## Maps and authoring

- [TrenchBroom manual](https://trenchbroom.github.io/manual/latest/) for Valve
  220 projection, FGD/entity definitions, game configuration, and editor behavior.
- [TrenchBroom source](https://github.com/TrenchBroom/TrenchBroom), inspected at
  `eb9db6ff5a19d1b8379c071cbd338e527c2e32fc`, especially its Valve map reader,
  serializer, brush geometry, and tests.
- [The Level Design Book: MAP format](https://book.leveldesignbook.com/appendix/resources/formats/map)
  for a concise grammar overview and the Valve 220 face form:
  `texture [u-axis offset] [v-axis offset] rotation scale-x scale-y`.

## Reading discipline

Source material explains mechanisms, not project requirements. Record which
constraint a borrowed idea solves. Respect each repository's license, write
original focused fixtures, and validate old networking advice against browser
transport and the current Box3D build.
