# 0007: Production test harnesses

Status: accepted on 2026-07-21; transport model amended by 0012.

Treat deterministic simulation, shaped-link, headless-client, browser, and soak
harnesses as production-adjacent tooling. They use the real server, codecs,
controller, prediction, interpolation, and persistence boundaries; they are not
throwaway mocks.

This keeps latency, correction, interpolation, backpressure, reset, and scale
measurable throughout development. The first reliable-ordered link primitive was
replaced with a deterministic expiring-datagram model when 0012 separated
gameplay state from WebSocket control. The harness now establishes real WebRTC
peers before applying seeded loss, latency, jitter, reordering, bandwidth,
outages, and receiver stalls to application datagrams.

Evidence begins in [`../../tools/network-harness/`](../../tools/network-harness/)
and grows alongside the multiplayer implementation.
