# Architecture

## Runtime

One Bun process serves the browser application, accepts WebSockets, terminates
WebRTC data channels, coordinates the world, simulates host-owned objects, and
persists accepted state through `bun:sqlite`.

Each browser runs two execution domains:

- the main thread samples input, manages the session, buffers presentation, and
  renders with Three.js/WebGPU;
- a dedicated module worker loads the same Box3D adapter as Bun and simulates
  objects owned by that browser.

Bun uses `werift@0.23.0`; browsers use the platform WebRTC implementation.
`box3d.js@0.0.2` is loaded as separate Wasm in Bun and in the physics worker.
There is no separate frontend server, game server service, or authority-election
system.

In development, Bun may expose a second MCP listener bound to `127.0.0.1`.
MCP-created players, props, and diagnostics are host-owned and ephemeral.

## Source boundaries

```text
apps/
  web/             input, session, owner physics worker, presentation, Three.js
  server/          world host/coordinator, transport, persistence, metrics
packages/
  engine/          protocol, replication, Box3D adapter, generic capabilities
  game/            compiler, entities, shared controller/carry/simulation policy
tools/
  network-harness/ real Bun/WebRTC profiled multiplayer harness
  generate-fgd/
  compile-map/
content/
  maps/ textures/ sprites/ models/ generated/
```

DOM and Three.js stay out of packages. SQLite, filesystem, administration, and
server sockets stay in the server app. The engine never knows mapper classnames.
Player and prop controllers live in `packages/game` so the browser authority and
Bun's MCP/host authorities use the same fixed-step policy.

## State ownership

| State                                       | Authority / owner     | Lifetime                    |
| ------------------------------------------- | --------------------- | --------------------------- |
| Authored geometry/defaults                  | compiled world bundle | one `mapRevision`           |
| Browser network player                      | that browser          | connected player assignment |
| Held prop                                   | lease-holding browser | one grab lease              |
| Unheld prop                                 | Bun host              | until a lease grant         |
| Mechanism, trigger, mover, diagnostic actor | Bun host              | one `worldEpoch`            |
| Joint graph                                 | Bun host              | one `worldEpoch`            |
| Contraption manipulation claim              | Bun coordinator       | one press/claim             |
| Ownership/lifecycle registry                | Bun coordinator       | one `worldEpoch`            |
| Nonowned collision proxy                    | each nonowner         | disposable                  |
| Buffered presentation                       | each browser          | disposable                  |
| Latest accepted durable state               | Bun/SQLite            | process restarts            |

Only the current authority simulates an object dynamically. Other peers keep a
kinematic or motion-disabled proxy for collision and queries and render from a
separate interpolation buffer.

Generic body/query/control access and host mechanism construction are separate
game capabilities. Only Bun receives the capability that creates native joints
or mutates a mechanism's surface velocity. Browser workers evaluate immutable
conveyors and gravity fields for their owned player or held prop, but never
construct a joint graph.
For direct contraption manipulation, the worker owns only target smoothing and
publishing. Bun creates a private kinematic control body and native motor joint,
keeps the complete graph dynamic in one Box3D world, and destroys that temporary
constraint on release, timeout, disconnect, respawn, or reset.

## Identity and versioning

| Concept                 | Meaning                                       |
| ----------------------- | --------------------------------------------- |
| `authoredId`            | stable persistence key for a map entity       |
| `{ index, generation }` | runtime identity safe against slot reuse      |
| `ownerPlayerId`         | nullable current browser owner                |
| `authorityVersion`      | monotonic ownership-assignment generation     |
| `stateSequence`         | uint16 per-object disposable-state sequence   |
| `mapRevision`           | SHA-256 compiled bundle identity              |
| `worldEpoch`            | global reset/reload generation                |
| `protocolVersion`       | exact wire compatibility version; currently 5 |

These values are independent. Runtime IDs, Box3D handles, and Wasm pointers are
never persistence keys.

## Persistence

SQLite stores typed application state using WAL mode, prepared statements, and
tick-boundary transactions. Bun persists its own Box3D state and the latest state
it accepted from browser owners. A normal release supplies a reliable final prop
state; transport loss causes immediate host takeover from the last accepted
state.

A save writes world metadata, bodies, players, and strictly validated gameplay
state atomically. Startup restores only a matching `mapRevision`. Ownership is
not durable across process startup: restored props begin host-owned.

## Reset transaction

Global reset increments `worldEpoch`, revokes every lease, recreates Bun's Box3D
world, rebuilds every connected browser worker, respawns and reassigns connected
players with new authority versions, persists the authored baseline, and sends a
reliable world bootstrap. Old-epoch control and state are rejected.

## Deployment

One Docker image contains Bun, the server bundle, browser assets, both browser
workers, Box3D Wasm, compiled world content, and SQLite support. One Bun process
serves HTTP/WebSocket and a bounded WebRTC UDP range. `/data/gurgur.sqlite` is the
only durable writable path.
