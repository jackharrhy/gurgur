# Work tracker

This is the only status document. Canonical behavior lives in the sibling docs.

Updated: 2026-07-25.

## Current state

The failed networking design has been reset to a compile-safe baseline:

- one Bun server still owns the persistent authoritative Box3D world and advances
  it at a fixed 60 Hz;
- clients still send intent only, on a disposable unordered WebRTC data channel;
- lifecycle, signaling, speech, reset, and world replacement remain on the
  reliable WebSocket control path;
- protocol v4 uses deliberately plain tagged JSON packets, one input command per
  packet, and full authoritative state samples;
- the server has no interest scheduler, selective state acknowledgement,
  per-client replication history, terminal-state delivery machinery, or network
  trace recorder;
- the browser renders only the newest authoritative sample. It has no local
  prediction, replay, reconciliation, interpolation, extrapolation, adaptive
  clock, or client Box3D worker;
- `mapRevision`, `worldEpoch`, persistence, authored identity, runtime identity,
  fixed stepping, lighting, audio, speech, entity behavior, and development MCP
  control remain separate and intact.

The baseline is intentionally not production-quality netcode. Visible 30 Hz
stepping and latency are expected, full snapshots are wasteful, and detailed
local grab presentation is incomplete.

## Stubbed validation

The former network matrix, network trace schema and UI, prediction/interpolation
tests, delivery scheduler tests, protocol-v3 tests, real-server networking
integration suite, and networking-dependent browser smoke script were removed.
`bun run test:network` and `bun run test:browser` fail with explicit reset
messages. `bun run check` covers the remaining repository only.

## Active focus

Reimplement networking from the invariant boundary:

- choose and document a small state/input protocol;
- add server state publication without ordered-current-state backlogs;
- add client presentation and local response deliberately, with real latency in
  the first vertical slice;
- restore focused protocol, multiplayer, reset/reconnect, and real-browser
  evidence alongside the implementation;
- establish new network profiles and budgets from measured behavior rather than
  inheriting the deleted design's claims.

Do not reintroduce old prediction, interest, acknowledgement, trace, or quality
machinery merely to satisfy deleted tests.
