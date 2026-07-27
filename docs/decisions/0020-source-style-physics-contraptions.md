# 0020: Source-style physics contraptions

Status: accepted, 2026-07-26.

Gurgur exposes a composable Source-style TrenchBroom vocabulary and compiles it
to three generic runtime archetypes: `physics-joint`, `surface-motor`, and
`gravity-field`. Joint graphs are fixed Bun authority. Their dynamic parts must
explicitly opt out of grab leasing, while loose props remain eligible for the
ordinary per-object ownership model.

The naming and composition model follows Valve's
[Portal 2 `base.fgd`](https://developer.valvesoftware.com/wiki/Base.fgd/Portal_2)
and TrenchBroom's
[FGD and rotation behavior](https://trenchbroom.github.io/manual/latest/index.html).
Runtime behavior maps directly to
[Box3D native joints](https://box2d.org/documentation3d/md_simulation.html).
Target-angle and target-velocity motor modes follow the pinned s&box
[`HingeJoint`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Scene/Components/Joint/HingeJoint.cs)
model.

Attachment targets and authored poses are compiler concerns. The bundle stores
entity indices and local frames, so restored bodies recreate the same anchors
without exposing mapper properties to the engine or protocol. Conveyors use
per-shape tangent velocity, and gravity fields are evaluated by whichever peer
currently simulates an object.

Whole-graph client authority is deferred because a graph cannot be split safely
across peers during an ordinary grab lease. Reimplementing constraints in
gameplay code is rejected because Box3D already supplies their limits, motors,
solver integration, destruction, and stale-handle semantics.

Direct interaction does not require that transfer: decision 0021 keeps the graph
on Bun and adds a temporary host control joint driven by a browser claim.
