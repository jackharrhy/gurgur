# Decision experiments

These folders contain disposable, isolated tests used to make architecture
decisions. They are not production packages and production code must not import
from them.

Each experiment owns its dependencies and records one decision:

- `physics-runtime/` — Box3D.js runtime and browser/Bun equivalence
- `realtime-transport/` — Bun's native authoritative WebSocket path
- `persistence/` — Bun SQLite snapshot transactions and restore rules
- `map-geometry/` — Valve 220 brush geometry, units, and axis conversion
- `player-controller/` — Box3D geometric capsule movement primitives

Run an experiment from its own directory. Once its acceptance criteria pass,
record the decision in `docs/` and retain the experiment as reproducible evidence.
