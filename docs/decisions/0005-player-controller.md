# 0005: Player controller

Status: accepted on 2026-07-21.

Use Box3D's geometric capsule mover with a following kinematic proxy, shared by
the server and prediction worker. Do not use a dynamic rigid body as the player.

The local experiment exercised `b3World_CollideMover`, `b3SolvePlanes`, and
`b3World_CastMover` against ground and wall geometry, proving depenetration, wall
stopping, and wall sliding. Box3D's own mover sample supplies the basis for
grounding, plane iteration, velocity clipping, and bounded impulses to dynamic
bodies. Crashcat supplies additional controller conformance cases.

The selection test covered depenetration, wall stopping, wall sliding, grounding,
and bounded dynamic-body impulses. Physics and browser prediction regressions now
preserve those invariants.

A geometric mover gives input-replayable control while explicit impulses retain
the puzzle interaction Gurgur needs. The proxy makes the otherwise virtual mover
visible to sensors, raycasts, and projectiles without letting a rigid body drive
movement.
