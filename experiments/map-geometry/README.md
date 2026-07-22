# Map geometry decision

Question: what unit and axis conversion does the Valve 220 compiler use, and can
one convex-brush algorithm produce deterministic shared render/collision input?

Run `bun run check`.

Acceptance criteria:

- plane-triplet intersection reconstructs the eight vertices and twelve
  triangles of an original Valve 220 cube fixture;
- repeated compiles are byte-for-byte deterministic;
- source-face identity survives triangulation;
- `(x, y, z) -> (x, z, -y)` preserves handedness;
- one map unit equals exactly 0.0254 metres, making 72 units equal 1.8288 m.

Decision after passing: use the stated transform and scale everywhere. Static
brushes compile into a shared indexed triangle surface used to create both the
Three.js render batches and Box3D static mesh data. Moving brushes compile to
convex hulls or compounds, never dynamic triangle meshes.
