# Realtime transport decision

Question: does Bun's native WebSocket server provide the protocol, binary
snapshot, connection-data, payload-bound, and backpressure primitives needed by
the authoritative gameplay path without `ws` or geckos.io?

Run `bun run check`.

Acceptance criteria:

- two clients complete a versioned handshake;
- duplicate sequences and stale world epochs are rejected;
- binary snapshots reach both clients and decode identically;
- server sends expose Bun's numeric backpressure result;
- mismatched protocol versions close with an explicit reason.

Decision after passing: gameplay uses Bun's native WebSocket server. Client
packets begin as JSON and hot snapshots use a small `DataView` binary format.
WebRTC is reserved for voice media, not gameplay state.
