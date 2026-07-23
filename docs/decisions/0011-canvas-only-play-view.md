# 0011: Canvas-only play view

Status: accepted on 2026-07-23.

The current product ships the world canvas without a HUD, reticle, visible
cursor, control overlay, or realtime voice. Browser diagnostics remain available
only as non-rendered state for automated tests.

Removing voice also removes its WebRTC media owner, signaling packets, peer graph,
session state, environment configuration, and dedicated test infrastructure.
This narrows the production slice for content authoring and gameplay networking.
Voice can be reconsidered later as a new scoped feature; the superseded design
record preserves the prior implementation rationale without keeping dormant code.
