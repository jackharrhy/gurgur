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

Source-style physics contraptions are implemented as a vertical slice:

- mapper joints compile to native revolute, prismatic, spherical, weld, and
  configurable distance joints with authored local frames;
- jointed graphs are fixed host authority and compiler-rejected when grabbable;
- multi-brush conveyors use Box3D tangent velocity for bodies and player support;
- compound gravity fields use deterministic priority and authority-local
  evaluation;
- enabled/reversed motor and conveyor state persists and replicates through the
  existing protocol-v5 body flags;
- compound sensors and moving bodies retain every convex brush child.
- every joint mapper exposes default-on procedural presentation derived from its
  compiled attachment frames;
- fixed-authority bodies are directly interactive through exclusive claims:
  browsers publish smoothed hit-point targets while Bun drives a native control
  joint and keeps the complete graph authoritative.

## Active focus

Breaking joints, pulley systems, wheel/suspension joints, runtime joint creation,
whole-graph client ownership, and conveyor texture scrolling are deferred.
Future protocol work should begin only from a measured failing budget or a
product requirement;
do not add prediction, reconciliation, extrapolation, collision ownership
transfer, or speculative interest management.
