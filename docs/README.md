# Gurgur documentation

Canonical documents describe the selected system. They do not track project
status, implementation order, or competing designs.

| Change                                                           | Authority                            |
| ---------------------------------------------------------------- | ------------------------------------ |
| Game purpose, player experience, scope                           | [`product.md`](product.md)           |
| Runtime topology, state ownership, identity, persistence         | [`architecture.md`](architecture.md) |
| Box3D adapter, stepping, collision, player controller            | [`physics.md`](physics.md)           |
| Valve 220 parsing, geometry, bundles, entity schema              | [`maps.md`](maps.md)                 |
| Vanilla browser shell, Three.js, and single-container deployment | [`web.md`](web.md)                   |
| Test layers and available validation                             | [`testing.md`](testing.md)           |
| Why a technology was selected or rejected                        | [`decisions/`](decisions/)           |
| Current tasks and completion state                               | [`work.md`](work.md)                 |

Accepted technology choices and compact evidence summaries live in
[`decisions/`](decisions/). Superseded plans and one-off experiments are removed
once their durable conclusions have been recorded.

Background research lives in the
[networked-physics deep dive](networked-physics-deep-dive.md). Its focused
[client-feel follow-up](networked-physics-client-feel.md) compares the remaining
owner-facing latency gap with s&box, Source, and Gaffer's models without changing
the selected canonical contract.

When evidence changes a decision, update its decision record and the canonical
document in the same change. A task is not architecture.
