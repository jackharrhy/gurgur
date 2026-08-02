# Physics

## Engine and binding

Gurgur uses Erin Catto's Box3D 0.1.0 through `box3d.js@0.0.2`. Bun and a
dedicated browser module worker load the package's single-threaded
separate-Wasm artifact through the same adapter. The inline artifact is retained
for diagnostics only. Native Box3D, multithreaded Wasm, Box2D, Crashcat, Rapier,
and Jolt are not runtime dependencies.

The dependency is pinned as a pair:

- `box3d.js` commit `72491a34adcf6fc1cf562199d51b3766d5210e9d`;
- vendored Box3D commit `8441b4a06d6d09dcfb0b0f704df4d847d1437b92`.

Host and worker code import Gurgur's physics adapter from `packages/engine`. Raw
Embind objects and Wasm views do not cross that boundary. Gameplay simulation instead
receives the narrower `GameEngine` capability: body lookup/state,
kinematic targets, filtered raycasts, player proxies, bounded dynamic-body target
drives, and save requests.
It cannot step or dispose the world, construct arbitrary bodies, or extract
debug data.
Host mechanism construction receives a separate `HostMechanismEngine`
capability. It can create and mutate native joints—including temporary control
joints—gravity scale, and surface velocity without forcing browser
grab-controller adapters to expose dummy joint APIs.

The adapter's bounded debug extraction uses `b3World_Draw` only on demand. The
installed binding emits broad-phase bounds, joint segments, and live contact
points. Its shape callback is deliberately disabled upstream, and its mass
transform callback is not safe in this release, so neither is presented as
available. `?debug` polls a cached current frame at 10 Hz; this diagnostic JSON is
separate from gameplay replication and never serializes Wasm pointers or IDs.

## Resource ownership

Runtime Box3D IDs are wrapped in `{ index, generation }` handles and validated on
every external lookup. Destruction requested during a physics step or callback is
queued for the post-step phase. Destroying a world invalidates all handles issued
by that world. Box3D can report a terminal contact, sensor, hit, or move event
whose body was destroyed after the preceding step; extraction drops that stale
event instead of resolving it into a recycled runtime handle.

Hull source data is copied by Box3D and can be released after shape creation.
Mesh, compound, and height-field backing allocations remain owned by the adapter
until every referencing shape and world is destroyed. Reusable Wasm-backed
buffers collect contacts, sensors, movement, and mover planes without allocating
one JavaScript object per event. Heap-backed views are refreshed after memory
growth.

## Simulation

Every physics authority advances its world at exactly 60 Hz with four Box3D
substeps. Forces, impulses, kinematic targets, controller input, and mechanism
commands are applied before the step. Contacts, sensors, moved bodies, sleep
transitions, and deferred destruction are processed afterward.

Bun dynamically simulates every shared prop, fixed-authority mechanism, MCP
player, and diagnostic body. A browser worker simulates only that browser's
geometric player controller. Every shared network body in a browser world is a
motion-disabled kinematic proxy. Ordinary contact never changes authority.

Disposable state is sampled by source simulation tick rather than receipt time.
Browser collision proxies and Bun's externally owned player proxies are driven
by position-and-rotation kinematic targets at fixed-step boundaries from the
same eight-tick timeline. Packet callbacks update buffers and capability flags;
they do not teleport ordinary collision proxies.

The host and browser loops execute at most four catch-up ticks per turn.
Persistence captures host application state only at a completed tick boundary.
Locally owned rendering interpolates consecutive completed worker steps. Remote
render tracks adapt independently from four to eight source ticks using recent
late-arrival and underrun evidence and never extrapolate. Render timing does not
alter the fixed eight-tick collision or host player-proxy tracks.

## Coordinates and scale

TrenchBroom uses Z-up map space. Three.js and Box3D use Y-up world space. The only
coordinate conversion is:

```text
map (x, y, z) -> world (x, z, -y) * 0.0254
```

One map unit is exactly one inch, or 0.0254 metres. The transform preserves
handedness. The compiler applies it to render vertices, collision vertices,
origins, directions, rotations, and entity dimensions. Runtime code never
performs ad hoc axis swaps or unit conversion.

## Collision geometry

The map compiler produces one deterministic indexed surface from each validated
convex brush set. Static world surfaces are grouped by collision properties and
created as Box3D static triangle meshes. Render batches and collision meshes share
the same converted vertices and source-face identity, while keeping independent
indices where material batching requires it.

Moving brush entities are convex hulls or compounds of convex hulls. A dynamic
multi-brush entity remains several convex shapes on one moving body; Box3D's
static-only compound-shape primitive is never used for it. The first brush
centre is the stable body and presentation origin. Doors and
platforms are kinematic bodies. Triggers are sensor shapes. Loose props are
dynamic bodies. Terrain uses a static mesh unless a height field is explicitly
authored. Dynamic concave triangle meshes are forbidden.

One sensor body may contain several convex sensor shapes. Gameplay maintains
per-visitor overlap reference counts, so crossing between adjacent brushes in
one trigger or gravity field produces one logical enter and exit.

## Physics contraptions

`physics-joint` entities map directly to Box3D revolute, prismatic, spherical,
weld, and distance joints. Revolute and prismatic joints support authored-pose
limits plus friction, target-angle/position spring motors, and target-velocity
motors. Distance joints implement rope, rigid rod, and damped spring behavior.
All joints use compiler-produced local frames; restoring body transforms never
redefines an anchor from the restored world pose. Connected-body collision is
disabled.

Joint graphs are always Bun authority. Browsers receive each connected body as a
kinematic collision/query proxy and never recreate the graph. These bodies have
`fixed` transfer policy, and compilation requires explicitly non-grabbable
interaction before a body may join a graph.

Direct manipulation does not relax that rule. Bun creates an untracked private
kinematic helper body and a Box3D motor/control joint from it to the captured
body-local hit point. Browser target state moves only the helper. All
contraption bodies, authored joints, contacts, motors, and the temporary control
joint therefore solve together in Bun's world. The helper has no runtime,
network, renderer, or persistence identity and is destroyed with the claim.
Force and torque limits scale with target mass; position and rotation use
separate spring frequencies and damping.

Every body tracks all child shapes. Setting conveyor velocity updates the native
surface material on every child, and the same tangent velocity is returned as
support point velocity to the geometric player controller. This gives rigid
bodies and players the same physical conveyor motion without translating the
conveyor body.

Gravity fields are evaluated by the relevant authority. Browsers evaluate them
for their player; Bun evaluates them for shared bodies. Highest priority wins;
ties use compiled entity order. The selected factor multiplies authored
`gravityScale`, including controller gravity. Leaving the last overlapping
shape restores the baseline.

## Constraint presentation

Compiled joints optionally carry one generic `constraint` presentation with a
style of hinge, motor, slider, ball socket, rope, rod, spring, or weld. It
contains no live physics state. The renderer derives both world anchors from
the compiled local frames and each presented body transform every frame. Ball
sockets render as balls; ropes sag between anchors; springs use a coiled line;
the other styles use compact axle, rail, rod, or weld markers. Presentation
therefore follows restored and replicated body poses without a mapper classname
branch or protocol message.

## Player controller

The player uses Box3D's geometric capsule mover, not a dynamic rigid body.
Player lifecycle, intent policy, interaction state, controller rules, collider
dimensions, and tuning live in `packages/game`; the engine retains only generic
capsule/query primitives. The standing capsule is 1.8 m tall with a 0.35 m
radius. The shared controller consumes fixed input commands on the current
authority: the owning browser for network players and Bun for MCP players.

Each controller tick:

1. updates horizontal velocity, gravity, jump, and moving-ground velocity;
2. collects planes with `b3World_CollideMover`;
3. resolves penetration and desired displacement with `b3SolvePlanes`;
4. limits motion with `b3World_CastMover`;
5. repeats for at most five iterations with a 1 cm movement tolerance;
6. clips velocity and applies bounded reaction impulses only where the current
   authority also owns the dynamic body.

Browser-side shared bodies are kinematic proxies, so local player movement
cannot author an impulse for them. Bun's delayed kinematic player proxy can
push Bun-owned bodies in the shared solver. This is the selected one-way
player/body coupling contract.

A fixed-tick controller result must be finite and move no more than one metre.
The current authority rejects a larger Box3D depenetration result, retains the
prior pose, consumes the yaw/jump edge, and zeroes vertical velocity. This is a
safety invariant for pathological overlapping contact piles, not ordinary speed
clamping.

The player authority respawns it at `info_player_start` after it falls ten metres
below the map's lowest static collision vertex. Respawn clears held movement and
grabs, recreates the query proxy, and commits the discontinuity through reliable
control. A disconnected network player's frozen host proxy therefore cannot
accumulate unbounded free-fall state beneath the map.

Ground is walkable through 50 degrees. The controller steps up at most 0.30 m and
snaps down at most 0.40 m while grounded. Jumping suppresses ground snapping until
vertical velocity becomes non-positive. Moving-platform point velocity is added
before movement and retained through the tick.

A kinematic proxy capsule follows the geometric mover after resolution. The proxy
exists for sensors, raycasts, projectiles, and contact identity; it does not drive
player movement. Teleport, respawn, crouch-size change, and epoch reset update the
mover and proxy atomically.
Sensor shapes remain visible to proxy overlap events but are excluded from
geometric mover, capsule-fit, sweep, and ordinary controller-ray queries.

## Prop target controller

Grabbing is a game-owned target controller, not ownership transfer. The browser
chooses the first grabbable body on its 3.25 m view ray and requests an
exclusive claim containing identity, current authority version, centre-of-mass
anchor, and hold distance. Bun validates type, version, epoch, finite values,
availability, and reach; the first valid request wins.

The browser derives stable distance from compiled prop extent and advances a
target toward the player's chest-forward view at bounded speed. A filtered ray
that excludes the target shortens motion before world geometry. Desired
rotation preserves the orientation captured relative to player yaw.

At 60 Hz the browser publishes only that disposable target. Bun's private
control joint converts target error into force and torque while the prop,
contacts, and every other shared body remain in one solver. Driving the centre
of mass avoids arbitrary face-hit torque for loose props; explicitly
manipulable contraptions retain their hit offset. Bun publishes the manipulated
body as a 60 Hz hot state while ordinary body state remains 30 Hz.

After Bun reliably grants a loose-prop claim, the renderer may move only that
prop's mesh from the local target over one 60 Hz interval. The physics worker's
ordinary kinematic proxy remains authoritative for player collision and queries.
The speculative pose is never installed in Box3D or encoded on the wire. On
release its visual offset converges to the authoritative render track with
bounded linear and angular correction. Contraption presentation stays entirely
authoritative because a target-following part without its joint graph would be
misleading.

Release destroys only the temporary control joint. The prop never changes body
type, authority version, solver, or persisted identity, so there is no final
pose/velocity physics handoff to reconcile. Presentation reconciliation changes
only the claimant's rendered mesh.
