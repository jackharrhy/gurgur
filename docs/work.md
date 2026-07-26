# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-07-26.

## Current state

Protocol v5 is implemented as one per-object-authority vertical slice:

- browsers simulate and publish their own players in a dedicated 60 Hz Box3D
  module worker;
- Bun simulates unowned props and every fixed host object;
- exclusive first-wins grab leases move held-prop simulation into the browser;
- nonowners use kinematic collision proxies and 100 ms buffered presentation;
- local owner presentation interpolates fixed worker steps without prediction;
- reliable bootstrap, lifecycle, authority, release, respawn, and reset carry
  complete state;
- unordered owner/cluster traffic uses bounded binary deltas, acknowledgements,
  resend, backpressure coalescing, and stale authority rejection;
- disconnect immediately reclaims leases while preserving the ten-second frozen
  player reconnect grace;
- persistence stores Bun state and the latest accepted browser-owned state.

The real Bun/WebRTC integration suite, profiled network matrix, real Chrome
scenarios, and protocol/ownership/presentation tests are active. The release
matrix gates 16 players/128 props; 32 players/256 props remains a nonblocking
stress report.

## Active focus

No protocol-v5 implementation work is intentionally deferred. Future protocol
work should begin only from a measured failing budget or a product requirement;
do not add prediction, reconciliation, extrapolation, collision ownership
transfer, or speculative interest management.
