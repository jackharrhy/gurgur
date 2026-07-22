# 0003: Persistence

Status: accepted on 2026-07-21.

Use `bun:sqlite` directly with WAL mode, strict tables, prepared statements, and
tick-boundary transactions. Do not use an ORM or serialize Box3D memory.

The local experiment atomically replaced typed snapshot rows, restored them in
stable authored-ID order, rejected an incompatible `mapRevision`, and represented
global reset by incrementing `worldEpoch` while clearing runtime body state.

Evidence: [`../../experiments/persistence/`](../../experiments/persistence/).
