# 0002: Gameplay transport

Status: accepted on 2026-07-21.

Use Bun's native server WebSocket and the browser WebSocket API. Control messages
use bounded JSON; fixed-rate inputs and snapshots use explicit `DataView` codecs.

The local experiment proved native versioned handshake, per-connection state,
stale epoch and duplicate-sequence rejection, binary broadcast, protocol mismatch
closure, payload limits, and numeric send/backpressure results with two clients.

The selection test covered handshake versioning, stale epoch and duplicate input
rejection, binary broadcast, payload limits, and backpressure. Protocol and real
server tests now preserve those invariants.

This path has the smallest deployment and runtime surface. geckos.io introduces a
native WebRTC server dependency and ICE/UDP operations, while WebTransport adds a
second server stack. Neither is used for gameplay. WebSocket head-of-line behavior
is handled by bounded queues, disposable state samples, and separate bulk pacing.
