# Architecture

## Runtime

One Bun process serves the browser, terminates WebSocket/WebRTC, coordinates and
simulates the authoritative world, and persists completed tick state through
`bun:sqlite`.

Each browser has two execution domains:

- the main thread samples intent, manages transport, records diagnostics, and
  renders with Three.js/WebGPU;
- a dedicated module worker loads the same Box3D adapter and shared gameplay
  controllers as Bun, predicts the local player plus a bounded nearby loose-body
  contact island, retains proxy history, and performs checkpoint restore/replay.

Bun uses `werift@0.23.0`; browsers use platform WebRTC. Both load
`box3d.js@0.0.2` as separate Wasm instances. There is no authority election or
second game-server service.

## Source boundaries

```text
apps/
  web/             input, session, prediction worker, presentation, Three.js
  server/          authoritative host, transport, persistence, metrics
packages/
  engine/          protocol v7, replication, Box3D adapter, generic capabilities
  game/            compiler, entities, shared controller/grab/simulation policy
tools/
  network-harness/ real Bun/WebRTC profiled multiplayer harness
content/
  maps/ textures/ sprites/ models/ generated/
```

DOM and Three.js stay out of packages. SQLite, filesystem, administration, and
server sockets stay in the server app. Mapper classnames stop at the compiler.
`stepPlayerController` and `stepPropGrab` live in `packages/game` and are called
by both authoritative and predicted adapters.

## State ownership

| State                                 | Authority / owner | Lifetime                |
| ------------------------------------- | ----------------- | ----------------------- |
| Authored geometry/defaults            | compiled bundle   | one `mapRevision`       |
| Every network player                  | Bun               | session/player identity |
| Every shared rigid body and mechanism | Bun               | one `worldEpoch`        |
| Prop/contraption claim                | Bun coordinator   | one claim               |
| Local player prediction history       | local browser     | 128 commands            |
| Confirmed held-prop prediction        | local browser     | confirmed claim         |
| Nearby loose-body prediction set      | local browser     | one checkpoint interval |
| Nonpredicted collision proxy/history  | each browser      | disposable              |
| Buffered/corrected presentation       | each browser      | disposable              |
| Persisted application state           | Bun/SQLite        | process restarts        |

Prediction is a cache of Bun-owned state, not another authority. The local
player, held prop, and checkpoint-selected nearby loose bodies are dynamically
simulated in the browser only so commands and reciprocal local contacts can be
presented immediately and replayed. No predicted result enters persistence,
host gameplay, or an outbound state packet.

Joint graphs are never cloned for rollback. Jointed bodies remain kinematic
browser proxies. Explicit contraption manipulation uses a Bun-native private
control joint; loose pickup uses the shared grab controller on Bun and the
bounded predicted held body in the browser.

## Identity and versioning

| Concept                 | Meaning                                             |
| ----------------------- | --------------------------------------------------- |
| `authoredId`            | stable persistence key                              |
| `{ index, generation }` | runtime identity safe against slot reuse            |
| `ownerPlayerId`         | nullable dynamic network owner; null in v7 gameplay |
| `authorityVersion`      | reliable state/discontinuity generation             |
| `stateSequence`         | uint16 disposable object-state sequence             |
| `sourceTick`            | uint32 authoritative production tick                |
| input sequence          | browser command identity and checkpoint ack key     |
| claim version           | exclusive interaction generation                    |
| `mapRevision`           | compiled bundle identity                            |
| `worldEpoch`            | reset/reload generation                             |
| `protocolVersion`       | exact wire compatibility; currently 7               |

These values are independent. Runtime IDs, Box3D handles, and Wasm pointers are
never persistence keys.

## Persistence and reset

SQLite writes bodies, players, world metadata, and typed gameplay state in one
tick-boundary transaction. Startup restores only a matching `mapRevision`.
Prediction records and presentation offsets are never durable.

Reset increments `worldEpoch`, revokes claims, recreates Bun's Box3D world,
respawns connected players with new authority versions, rebuilds each browser
worker from the reliable bootstrap, clears prediction/proxy/presentation
history, and rejects old-epoch input or state.

## Deployment

One image contains Bun, browser assets/workers, Box3D Wasm, compiled content,
and SQLite support. One Bun process serves HTTP/WebSocket and a bounded WebRTC
UDP range. `/data/gurgur.sqlite` is the only durable writable path.
