# Gurgur

Route work through the canonical document for the subsystem:

- Product behavior and scope: [`docs/product.md`](docs/product.md)
- Runtime boundaries, identity, and persistence: [`docs/architecture.md`](docs/architecture.md)
- Tick, protocol, ownership, replication, and transport: [`docs/networking.md`](docs/networking.md)
- Box3D integration, geometry, and controller: [`docs/physics.md`](docs/physics.md)
- Valve 220 compiler and entity schema: [`docs/maps.md`](docs/maps.md)
- Browser shell, Three.js, assets, and deployment: [`docs/web.md`](docs/web.md)
- Test harnesses, network profiles, and quality budgets: [`docs/testing.md`](docs/testing.md)
- Selected technology rationale: [`docs/decisions/README.md`](docs/decisions/README.md)
- Active work and status: [`docs/work.md`](docs/work.md)

Keep these invariants:

- Authority belongs to one peer per network object. A browser owns its player;
  Bun owns every shared rigid body plus mechanisms, triggers, movers, and
  diagnostic actors.
- Only an object's current authority runs its controller or dynamic simulation.
  Every nonowner represents it as a non-simulating collision proxy.
- Player authority, manipulation claims, lifecycle, persistence, mechanisms,
  spawning, deletion, and global reset remain coordinated by Bun.
- Every physics authority advances Box3D at 60 Hz with four substeps. Never step
  physics by render time or a remote peer's clock.
- There is no gameplay movement prediction, input replay, reconciliation,
  rigid-body extrapolation, or collision-based authority transfer. After Bun
  confirms a loose-prop claim, the holder may run an isolated speculative
  rendered view; it never feeds physics, queries, transport, or persistence.
- Reliable lifecycle/authority and disposable owner state use separate transport
  semantics. Never put current-state clusters behind an ordered reliable queue.
- `authorityVersion`, per-object state sequence, source tick, `worldEpoch`,
  `mapRevision`, and persistence version are separate.
- TrenchBroom Valve 220 maps and the TypeScript entity schema are authored truth.
- Joint-connected and loose dynamic bodies are fixed to Bun and never transfer
  authority to a browser.
- A browser may hold an exclusive manipulation claim on one fixed-authority
  body. Bun applies the browser's disposable target through a native control
  joint and keeps every shared contact in one dynamic solver; this is not
  ownership.

Canonical documents state selected behavior. Put TODOs, sequencing, and
completion status only in `docs/work.md`. Preserve durable rationale in a
decision record and focused production tests.

Prefer a complete vertical slice and direct code over speculative frameworks.
Build production systems with their harnesses. For networking behavior, run the
relevant multiplayer profile and real-browser gate.
