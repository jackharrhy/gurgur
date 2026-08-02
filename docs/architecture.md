# Architecture

## Runtime

One Bun process serves the browser application, accepts WebSockets, terminates
WebRTC data channels, coordinates the world, simulates host-owned objects, and
persists accepted state through `bun:sqlite`.

Each browser runs two execution domains:

- the main thread samples input, manages the session, buffers role-specific
  presentation, and renders with Three.js/WebGPU;
- a dedicated module worker loads the same Box3D adapter as Bun, simulates the
  browser's geometric player controller, and advances source-timed collision
  proxies.

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
Player and target controllers live in `packages/game`; only Bun receives the
capability that turns a browser target into force on a shared body.

## State ownership

| State                                       | Authority / owner     | Lifetime                    |
| ------------------------------------------- | --------------------- | --------------------------- |
| Authored geometry/defaults                  | compiled world bundle | one `mapRevision`           |
| Browser network player                      | that browser          | connected player assignment |
| Every held or unheld shared prop            | Bun host              | one `worldEpoch`            |
| Mechanism, trigger, mover, diagnostic actor | Bun host              | one `worldEpoch`            |
| Joint graph                                 | Bun host              | one `worldEpoch`            |
| Prop manipulation claim                     | Bun coordinator       | one press/claim             |
| Ownership/lifecycle registry                | Bun coordinator       | one `worldEpoch`            |
| Nonowned collision proxy                    | each nonowner         | disposable                  |
| Buffered presentation                       | each browser          | disposable                  |
| Confirmed loose-prop speculative view       | claiming browser      | one confirmed claim         |
| Latest accepted durable state               | Bun/SQLite            | process restarts            |

Only the current authority simulates an object dynamically. Other peers keep a
kinematic or motion-disabled proxy for collision and queries. Collision proxies
and rendering sample the replicated source-tick timeline independently. The
claiming browser may present a speculative loose-prop transform after a reliable
grant, but that transform is not a physics body, query input, network state, or
persisted state.

Generic body/query/control access and host mechanism construction are separate
game capabilities. Only Bun receives the capability that creates native joints
or mutates a mechanism's surface velocity. Browser workers evaluate immutable
conveyors and gravity fields for their player, but never construct a joint graph
or dynamically simulate a shared body. For every prop manipulation, the worker
owns only target smoothing and 60 Hz publishing. Bun creates a private kinematic
control body and native motor joint, keeps every shared contact dynamic in one
Box3D world, and destroys that temporary constraint on release, timeout,
disconnect, respawn, or reset. Bun prioritizes a currently manipulated body's
disposable result at 60 Hz; ordinary state remains 30 Hz.

## Identity and versioning

| Concept                 | Meaning                                        |
| ----------------------- | ---------------------------------------------- |
| `authoredId`            | stable persistence key for a map entity        |
| `{ index, generation }` | runtime identity safe against slot reuse       |
| `ownerPlayerId`         | nullable current browser owner                 |
| `authorityVersion`      | monotonic ownership-assignment generation      |
| `stateSequence`         | uint16 per-object disposable-state sequence    |
| `sourceTick`            | uint32 sample tick on the mapped host timeline |
| `mapRevision`           | SHA-256 compiled bundle identity               |
| `worldEpoch`            | global reset/reload generation                 |
| `protocolVersion`       | exact wire compatibility version; currently 6  |

These values are independent. Runtime IDs, Box3D handles, and Wasm pointers are
never persistence keys.

## Persistence

SQLite stores typed application state using WAL mode, prepared statements, and
tick-boundary transactions. Bun persists its Box3D state plus accepted
browser-player state. A prop release has no persistence or takeover transaction
because the prop never leaves Bun's solver.

A save writes world metadata, bodies, players, and strictly validated gameplay
state atomically. Startup restores only a matching `mapRevision`. Ownership is
not durable across process startup: restored props begin host-owned.

## Reset transaction

Global reset increments `worldEpoch`, revokes every claim, recreates Bun's Box3D
world, rebuilds every connected browser worker, respawns and reassigns connected
players with new authority versions, persists the authored baseline, and sends a
reliable world bootstrap. Old-epoch control and state are rejected.

## Deployment

One Docker image contains Bun, the server bundle, browser assets, both browser
workers, Box3D Wasm, compiled world content, and SQLite support. One Bun process
serves HTTP/WebSocket and a bounded WebRTC UDP range. `/data/gurgur.sqlite` is the
only durable writable path.
