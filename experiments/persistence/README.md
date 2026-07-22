# Persistence decision

Question: can `bun:sqlite` store an application-level world snapshot atomically,
reject an incompatible map revision, and represent a reset as a new world epoch?

Run `bun run check`.

Acceptance criteria:

- WAL mode and strict tables initialize without an external dependency;
- one transaction replaces the header and all authored body rows;
- restore is deterministic by authored ID;
- a mismatched `mapRevision` rejects the snapshot;
- reset increments `worldEpoch` and atomically clears runtime body state.

Decision after passing: use synchronous `bun:sqlite` with WAL, strict tables,
prepared statements, and tick-boundary transactions. Persist typed application
state only; never persist Box3D memory or handles.
