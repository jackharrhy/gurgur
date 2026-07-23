# Gurgur

Route work through the authoritative document for the subsystem:

- Product behavior and scope: [`docs/product.md`](docs/product.md)
- Runtime boundaries, identity, and persistence: [`docs/architecture.md`](docs/architecture.md)
- Tick, protocol, prediction, and transport: [`docs/networking.md`](docs/networking.md)
- Box3D integration, geometry, and controller: [`docs/physics.md`](docs/physics.md)
- Valve 220 compiler and entity schema: [`docs/maps.md`](docs/maps.md)
- Browser shell, Three.js, assets, and deployment: [`docs/web.md`](docs/web.md)
- Test harnesses, network profiles, and quality budgets: [`docs/testing.md`](docs/testing.md)
- Selected technology rationale: [`docs/decisions/README.md`](docs/decisions/README.md)
- Active work and status: [`docs/work.md`](docs/work.md)

Keep these invariants:

- One Bun server owns one persistent, authoritative Box3D simulation.
- Clients send intent, never authoritative transforms or interaction results.
- TrenchBroom Valve 220 maps and the TypeScript entity schema are authored truth.
- Physics advances at a fixed server timestep; never step it by client time.
- Replication, persistence, `mapRevision`, and `worldEpoch` are separate.

Canonical design documents state selected behavior. Put TODOs, sequencing, and
completion status only in `docs/work.md`. Preserve durable decision evidence in
a decision record and focused production tests; do not retain one-off experiment
implementations after a direction is selected.

Prefer a complete vertical slice and direct code over speculative frameworks.
Build production systems with their harnesses. For behavior changes, add focused
tests, run the relevant multiplayer profile, and keep generated files reproducible.
