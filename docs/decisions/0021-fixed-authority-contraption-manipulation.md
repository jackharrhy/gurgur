# 0021: Fixed-authority contraption manipulation

Status: accepted, 2026-07-26.

Players may directly pull a jointed `func_physics`, but that interaction does
not transfer body or graph authority. The browser owns an exclusive,
short-lived manipulation claim and publishes a smoothed desired hit-point
target. Bun creates a private kinematic helper and native control joint, keeps
every authored body and joint dynamic in one Box3D world, and replicates only
the resulting ordinary body states.

This follows the pinned Facepunch model. In
[Sandbox's `Physgun.cs`](https://github.com/Facepunch/sandbox/blob/1cee1dd28b6de82b21afdcecdbc3f34c0047152c/Code/Weapons/PhysGun/Physgun.cs),
networked `GrabState` describes the selected body and local hit point while the
peer with a non-proxy body creates and updates the control joint; grabbing does
not call object ownership transfer. Pinned s&box
[`GameObject.Network.cs`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Scene/GameObject/GameObject.Network.cs#L895-L961)
makes an unowned object non-proxy on the host, and its
[`ControlJoint`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Systems/Physics/Joints/ControlJoint.cs)
provides separate linear/angular spring control.

Transferring only the selected part is rejected because it would split one
constraint solver graph across peers. Transferring the whole graph is rejected
for this slice because it requires atomic multi-object authority, graph
lifecycle, collision-island handoff, and persistence semantics. Reducing levers
to signal-only buttons is rejected because it removes the continuous physical
interaction that makes the authored mechanism interesting.

Constraint visuals remain separate presentation. Sandbox's pinned
[`RopeTool`](https://github.com/Facepunch/sandbox/blob/1cee1dd28b6de82b21afdcecdbc3f34c0047152c/Code/Weapons/ToolGun/Modes/RopeTool.cs)
and
[`ElasticTool`](https://github.com/Facepunch/sandbox/blob/1cee1dd28b6de82b21afdcecdbc3f34c0047152c/Code/Weapons/ToolGun/Modes/ElasticTool.cs)
pair a physics joint with an independent rope renderer. Gurgur likewise derives
generic ball, axle, rail, rope, rod, spring, and weld markers from compiled
local frames and replicated body presentation. Mapper classnames and visual
state do not enter the network protocol.
