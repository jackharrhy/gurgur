# Gurgur documentation

Canonical documents describe the selected system. They do not track project
status, implementation order, experiments, or competing designs.

| Change | Authority |
| --- | --- |
| Game purpose, player experience, scope | [`product.md`](product.md) |
| Runtime topology, state ownership, identity, persistence | [`architecture.md`](architecture.md) |
| Input, replication, prediction, WebSocket, voice | [`networking.md`](networking.md) |
| Box3D adapter, stepping, collision, player controller | [`physics.md`](physics.md) |
| Valve 220 parsing, geometry, bundles, entity schema | [`maps.md`](maps.md) |
| Vanilla browser shell, Three.js, and single-container deployment | [`web.md`](web.md) |
| Test layers, multiplayer harness, network profiles, budgets | [`testing.md`](testing.md) |
| Why a technology was selected or rejected | [`decisions/`](decisions/) |
| Current tasks, experiment criteria, completion state | [`work.md`](work.md) |
| Primary sources and inspected revisions | [`references.md`](references.md) |

The original planning notes are retained in [`archive/`](archive/) for
provenance. They are not instructions.

When evidence changes a decision, update its decision record and the canonical
document in the same change. A task is not architecture, and an experiment is not
production code.
