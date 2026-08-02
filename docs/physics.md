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

Bun dynamically simulates every player, shared prop, fixed-authority mechanism,
MCP player, and diagnostic body. A browser worker dynamically predicts its local
geometric player and one confirmed held loose prop. Every other shared body is a
kinematic collision/query proxy. Ordinary contact never changes authority.

Disposable state is indexed by source simulation tick rather than receipt time.
Browser collision proxies normally target the newest accepted authoritative
transform. During checkpoint replay they sample retained history at the replayed
server tick, then return to newest state. Packet callbacks update history and
capability flags; they do not advance physics.

The host and browser loops execute at most four catch-up ticks per turn.
Persistence captures host application state only at a completed tick boundary.
Local prediction renders the newest completed worker step. Remote render tracks
adapt independently from four to eight source ticks and never extrapolate.
Nearby, touching, or supporting rigid bodies temporarily render from their
collision-aligned pose; render timing never alters physics.

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
radius. Bun consumes numbered fixed input commands for every player. The browser
replays the same commands through the same controller for its bounded local
prediction.

Each controller tick:

1. updates horizontal velocity, gravity, jump, and moving-ground velocity;
2. collects planes with `b3World_CollideMover`;
3. resolves penetration and desired displacement with `b3SolvePlanes`;
4. limits motion with `b3World_CastMover`;
5. repeats for at most five iterations with a 1 cm movement tolerance;
6. clips velocity and applies bounded reaction impulses only where that
   simulation also dynamically owns the affected body.

Browser-side unpredicted bodies are kinematic proxies, so their local reaction
impulse never becomes gameplay truth. Bun applies authoritative player reaction
impulses to Bun-owned bodies. A confirmed held prop is the one shared body
dynamically included in browser prediction and is corrected by Bun checkpoints.

A fixed-tick controller result must be finite and move no more than one metre.
The current authority rejects a larger Box3D depenetration result, retains the
prior pose, consumes the yaw/jump edge, and zeroes vertical velocity. This is a
safety invariant for pathological overlapping contact piles, not ordinary speed
clamping.

Bun respawns a player at `info_player_start` after it falls ten metres below the
map's lowest static collision vertex. Respawn clears held movement and grabs,
recreates the query proxy, increments the reliable generation, and replaces
browser prediction history.

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

Grabbing is a game-owned target controller, not ownership transfer. Primary is a
numbered command edge. Bun raycasts from its authoritative player pose and view,
validates type, epoch, availability, and reach, and grants the first valid loose
prop claim. The claim and complete grab seed return in the player's next
prediction checkpoint.

After confirmation, Bun and the browser run the same `stepPropGrab`. The target
moves toward the chest-forward view at at most 12 m/s, rotation at 2π rad/s, and
the body drive is limited to 12 m/s and 50 m/s². A filtered obstruction ray
shortens carry distance. The prop is a real dynamic body in the browser's local
prediction world and is rendered from that body, never from `targetPosition`.

Bun remains gameplay authority and publishes the held body as a 60 Hz hot state.
Each checkpoint restores player, body, velocities, and grab seed before command
replay. The browser sends neither a loose-prop transform nor a loose grab target.

Release is another command edge. A browser that already has a confirmed grab
predicts that edge during command replay, while Bun remains authoritative for
the claim and final body state. This prevents later unacknowledged commands from
continuing a grab that their own command stream has released. Presentation
decays toward the authoritative body with a per-frame discontinuity bound. The
body never changes authority, solver, or persisted identity.

Explicitly `manipulate` jointed bodies keep the separate server-only control
joint path. Predicting one detached part without its joint graph is forbidden.
