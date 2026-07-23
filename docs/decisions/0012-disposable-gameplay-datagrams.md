# 0012: Separate reliable control from disposable gameplay state

Status: accepted on 2026-07-23. Supersedes 0002 and 0010.

Keep native Bun WebSocket for authenticated connection control, world/lifecycle
messages, WebRTC signaling, ping/pong, and the initial complete snapshot. Carry
fixed-rate input and current state over two sender-owned, unordered WebRTC data
channels. Input has zero retransmissions and three-command application
redundancy. State permits one retransmission, targets 1,200 application bytes,
and is dropped rather than queued once two target packets are buffered.

The prior WebSocket design made disposable snapshots share one ordered reliable
byte stream with control. Under loss, an old snapshot had to arrive before a
newer snapshot could be observed. Replacing a pending application object could
not remove bytes already accepted by TCP, and the original loopback shaper sat
after the real socket, so it did not reproduce that server/TCP queue.

The replacement follows two useful properties in s&box at commit
`1a22bc7ef110feba1b8158df37377045473a5a90`:

- `NetFlags.UnreliableNoDelay` combines unreliable, immediate, and
  discard-on-delay behavior;
- `DeltaSnapshotSystem` sends per-connection snapshot clusters over unreliable
  flags and tracks acknowledgement/baseline state independently.

Gurgur does not copy s&box code or adopt its ownership model. It uses
self-contained quantized snapshots, which recover from loss without requiring a
received delta baseline. The reference supports the transport conclusion:
obsolete state must be disposable below the application queue.

The server implementation uses `werift@0.23.0` so the one Bun process can
terminate ICE/DTLS/SCTP without a native sidecar. Inspection and the real harness
found that this pinned version's lifetime expiry mixes millisecond and second
epochs, so `maxPacketLifeTime` does not expire as intended. Gurgur does not patch
or vendor the package. The server uses its working one-retransmission mode and
owns creation of the state channel so that policy applies at the sender.

Werift currently brings `ip@2.0.1`, which is reported by the package audit. The
reachable werift calls use address parsing, loopback checks, and buffer
conversion rather than the advisory's public-address classifier. This accepted
dependency remains pinned; Gurgur does not replace it with a local shim or an
unrelated package.

Production evidence is the real WebRTC server integration, the deterministic
datagram shaper, the 16-peer/128-prop matrix, browser movement smoke, bounded UDP
configuration tests, and server metrics for transport count, buffered bytes,
and dropped state.

Primary reference locations:

- [s&box network flags](https://github.com/Facepunch/sbox-public/blob/1a22bc7ef110feba1b8158df37377045473a5a90/engine/Sandbox.Engine/Systems/Networking/System/NetworkEnums.cs)
- [s&box delta snapshots](https://github.com/Facepunch/sbox-public/blob/1a22bc7ef110feba1b8158df37377045473a5a90/engine/Sandbox.Engine/Scene/Networking/DeltaSnapshots/DeltaSnapshotSystem.cs)
- [`../../apps/server/src/server.ts`](../../apps/server/src/server.ts)
- [`../../tools/network-harness/src/real-harness.ts`](../../tools/network-harness/src/real-harness.ts)
