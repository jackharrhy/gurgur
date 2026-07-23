# Architecture

## Runtime

One Bun process imports and serves the browser HTML application, accepts native
Bun WebSockets, runs the authoritative game state and Box3D world, and persists
snapshots through `bun:sqlite`. Browser clients use vanilla TypeScript and direct
Three.js, with a small prediction world in a module worker.

The selected runtime stack is:

- Bun 1.3.x with `Bun.serve`, native server WebSockets, HTML imports, the Bun
  bundler, and `bun:sqlite`;
- TypeScript for application, compiler, and protocol code;
- Three.js for browser rendering;
- `box3d.js@0.0.2`, single-threaded separate-Wasm build, in Bun and the browser;
- direct application registries rather than BitECS or a general game engine.

Gurgur does not use Remix, React, Elysia, Express, Vite, or a separate frontend
server. Bun owns HTTP routes, frontend asset delivery, WebSocket upgrades, the
simulation loop, and persistence in the same process and on the same origin.

Production code accesses Box3D only through Gurgur's physics adapter. Box3D owns
live physical state; application registries own stable identity and gameplay
state.

Persistent external resources have explicit lifecycle owners, but other modules
depend on small structural capability interfaces rather than concrete classes.
Pure transforms and short-lived registries use functions and plain data. The
server game loop composes world loading, runtime-body construction, mechanisms,
players, replication, and persistence; it does not implement every subsystem.

## Source boundaries

```text
apps/
  web/             HTML, vanilla TS, Three.js, input, prediction worker
  server/          sole Bun entrypoint, HTTP/WebSocket, simulation, administration
packages/
  shared/          packet types, codecs, input, controller rules, math
  physics/         lifecycle-safe box3d.js adapter
  map-format/      Valve 220 scanner/parser and source diagnostics
  world-compiler/  render/collision/entity bundle compiler
  entity-schema/   authored definitions, validation, FGD generation
tools/
  generate-fgd/
  compile-map/
  network-harness/  deterministic clients, link shaping, metrics, reports
content/
  maps/ textures/ models/ generated/
```

Browser, DOM, and Three.js code stay out of shared packages. SQLite, filesystem,
administration, and server sockets stay out of client packages.
The network harness is production-adjacent tooling: it imports the real shared
codecs and drives the real server and client simulation boundaries.

## State ownership

| State                          | Owner                 | Lifetime                |
| ------------------------------ | --------------------- | ----------------------- |
| Authored geometry and defaults | compiled world bundle | one `mapRevision`       |
| Live bodies and constraints    | server Box3D world    | one `worldEpoch`        |
| Gameplay and entity state      | server registries     | one `worldEpoch`        |
| Replicated view                | each client           | disposable              |
| Local-player prediction        | client worker         | until correction/reset  |
| Durable application state      | SQLite                | across process restarts |

Box3D handles, Wasm pointers, and registry slots are process-local. They are
wrapped in generation-bearing runtime handles and never persisted or sent as
stable identity.

## Identity and versioning

| Concept                 | Meaning                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `authoredId`            | explicit stable ID for a persistent map entity              |
| `{ index, generation }` | runtime network identity safe against slot reuse            |
| `mapRevision`           | SHA-256 content hash of the compiled world bundle           |
| `worldEpoch`            | monotonic reset/reload generation used to reject stale work |
| `protocolVersion`       | exact client/server wire compatibility version              |

Every persistent authored entity has a unique explicit `authoredId`, enforced by
the compiler. Source positions are diagnostics, never identity.

## Persistence

SQLite stores typed application state in strict tables using WAL mode, prepared
statements, and tick-boundary transactions. The default snapshot interval is five
seconds; important mechanism changes also request a snapshot at the next tick
boundary.

A snapshot contains `mapRevision`, `worldEpoch`, server tick, save time, authored
IDs, transforms, velocities, sleep state,
mechanism progress, trigger/relay latches, cooldown deadlines, queued delayed
signals, complete player-controller state, and authored grab ownership. It never
contains raw Box3D memory, Wasm pointers, or runtime network IDs.

Startup restores a snapshot only when its `mapRevision` matches the compiled
bundle. Otherwise the server starts from authored defaults. This pre-release
schema is clean-start only: schema changes require deleting the local database,
not carrying migrations or compatibility branches.

## Reset transaction

A reset stops input consumption, increments `worldEpoch`, discards durable body
state, recreates the Box3D world from the compiled bundle, respawns connected
players, writes the reset snapshot, publishes a full snapshot, and resumes input.
Clients clear prediction and interpolation state associated with the previous
epoch.

## Deployment

One Dockerfile builds generated maps and browser assets, then produces one runtime
image containing Bun and the server bundle. The container starts exactly one Bun
process, listens on one HTTP port, and serves HTTP, static assets, health checks,
administrative endpoints, and gameplay WebSockets from that process.

SQLite lives at `/data/gurgur.sqlite` on a mounted persistent volume. Compiled
world content is immutable image content. On `SIGTERM`, the server stops accepting
new connections, completes the current tick, writes a final snapshot, closes
SQLite and WebSockets, then exits within the container grace period.
