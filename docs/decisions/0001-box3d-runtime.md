# 0001: Box3D runtime

Status: accepted on 2026-07-21.

Use `box3d.js@0.0.2` with the single-threaded separate-Wasm artifact in Bun and a
browser module worker, behind a Gurgur-owned adapter. Pin the wrapper and vendored
Box3D revisions together.

The package mirrors the current Box3D C API, provides TypeScript declarations,
and exposes reusable packed event buffers. The local experiment ran repeated
world lifecycle, fixed stepping, movement events, and contacts through both
single-threaded artifacts in Bun 1.3.14 and Chrome; both variants produced the
same rounded state.

The selection test exercised repeated world lifecycle, fixed stepping, movement
events, and contacts in Bun and Chrome with matching rounded state. Production
adapter tests now preserve those invariants.

Multithreaded Wasm adds cross-origin isolation without a demonstrated need.
Inline Wasm prevents independent browser caching. A custom binding would duplicate
young upstream work and is justified only by a concrete missing requirement.
