# Player-controller decision

Question: does Box3D's geometric capsule mover provide the collision primitive
for Gurgur's server-authoritative, client-replayed controller?

Run `bun install --frozen-lockfile && bun run check`.

The current conformance test proves ground depenetration, wall stopping, and wall
sliding through `b3World_CollideMover`, `b3SolvePlanes`, and
`b3World_CastMover`.

Decision: use the geometric mover, not a dynamic player body. A kinematic proxy
shape follows it for sensors, raycasts, and projectile contacts. The controller
applies bounded impulses to contacted dynamic puzzle bodies.

The full arena still must add stairs, slopes, jumping, moving platforms,
prediction replay, browser equivalence, and impulse coupling before the movement
slice is considered complete; those are conformance work for the selected
controller, not a renewed engine comparison.
