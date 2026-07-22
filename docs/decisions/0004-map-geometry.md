# 0004: Map geometry and units

Status: accepted on 2026-07-21.

One map unit is one inch (`0.0254 m`). Convert Valve Z-up coordinates with
`(x, y, z) -> (x, z, -y)`. Use an owned Valve 220 parser and convex half-space
compiler. Static brushes produce deterministic indexed triangle surfaces; moving
brushes produce convex hulls or compounds.

The local experiment reconstructed a Valve 220 cube from plane triplets, retained
source-face identity, generated eight vertices and twelve triangles, verified the
world extents and six-foot/72-unit scale, and produced a stable SHA-256 result.

The selection test reconstructed a Valve 220 cube, retained source-face identity,
verified the selected unit conversion, and produced a stable content hash. Parser,
compiler, and production-map tests now preserve those invariants.

Owning the focused parser preserves source diagnostics and avoids adopting a
general map/compiler framework. The inch scale matches established Quake-family
human dimensions while presenting Box3D with metre-sized bodies.
