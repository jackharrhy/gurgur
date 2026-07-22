# 0007: Production test harnesses

Status: accepted on 2026-07-21.

Treat deterministic simulation, shaped-link, headless-client, browser, and soak
harnesses as production-adjacent tooling. They use the real server, codecs,
controller, prediction, interpolation, and persistence boundaries; they are not
throwaway mocks.

This keeps latency, correction, interpolation, backpressure, reset, and scale
measurable throughout development. A deterministic reliable-ordered link model
is the first shared primitive. It represents network loss as retransmission delay
and head-of-line blocking, matching the selected WebSocket semantics.

Evidence begins in [`../../tools/network-harness/`](../../tools/network-harness/)
and grows alongside the multiplayer implementation.
