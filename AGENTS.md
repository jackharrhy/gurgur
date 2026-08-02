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

- Bun owns every network player and shared rigid body plus mechanisms, triggers,
  movers, and diagnostic actors. Browsers never publish gameplay transforms.
- A browser predicts its local player, one Bun-confirmed loose held prop, and
  only the bounded nearby loose-body set carried by Bun's checkpoint. Every
  other nonowner representation is a non-simulating collision proxy.
- Player simulation, manipulation claims, lifecycle, persistence, mechanisms,
  spawning, deletion, and global reset remain authoritative in Bun.
- Every physics authority advances Box3D at 60 Hz with four substeps. Never step
  physics by render time or a remote peer's clock.
- Prediction uses the same `stepPlayerController`, `stepPropGrab`, Box3D adapter,
  fixed tick, and four substeps as Bun. Checkpoints restore authoritative state
  and replay unacknowledged commands; prediction never becomes host truth.
- Input commands are sampled intent, not a movement-work FIFO. Bun consumes the
  newest delivered intent once per tick and recovers bounded action-counter
  edges without replaying already elapsed movement time.
- Reliable lifecycle/discontinuities and disposable input/current state use
  separate transport semantics. Never put current input or state clusters behind
  an ordered reliable queue.
- `authorityVersion`, per-object state sequence, source tick, `worldEpoch`,
  `mapRevision`, and persistence version are separate.
- TrenchBroom Valve 220 maps and the TypeScript entity schema are authored truth.
- Joint-connected and loose dynamic bodies are fixed to Bun and never transfer
  authority to a browser.
- A loose grab target is derived by Bun from authoritative player commands and
  predicted locally only after confirmation. Explicit jointed manipulation may
  send a disposable target to Bun's native control joint; neither path is
  ownership.

Canonical documents state selected behavior. Put TODOs, sequencing, and
completion status only in `docs/work.md`. Preserve durable rationale in a
decision record and focused production tests.

Prefer a complete vertical slice and direct code over speculative frameworks.
Build production systems with their harnesses. For networking behavior, run the
relevant multiplayer profile and real-browser gate.
