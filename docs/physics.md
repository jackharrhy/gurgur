# Physics

## Engine and binding

Gurgur uses Erin Catto's Box3D 0.1.0 through `box3d.js@0.0.2`. Both the Bun
authority and browser prediction worker load the package's single-threaded
separate-Wasm artifact. The inline artifact is retained for diagnostics only.
Native Box3D, multithreaded Wasm, Box2D, Crashcat, Rapier, and Jolt are not
runtime dependencies.

The dependency is pinned as a pair:

- `box3d.js` commit `72491a34adcf6fc1cf562199d51b3766d5210e9d`;
- vendored Box3D commit `8441b4a06d6d09dcfb0b0f704df4d847d1437b92`.

Host and prediction code import Gurgur's physics adapter from `packages/engine`.
Raw Embind objects and Wasm views do not cross that boundary. Gameplay simulation
instead receives the narrower `GameEngine` capability: body lookup/state,
kinematic targets, raycasts, player proxies, grab constraints, and save requests.
It cannot step or dispose the world, construct arbitrary bodies, or extract
debug data.

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

The server advances one world at exactly 60 Hz with four Box3D substeps. Forces,
impulses, kinematic targets, controller input, and mechanism commands are applied
before the step. Contacts, sensors, moved bodies, sleep transitions, and deferred
destruction are processed afterward.

The host loop executes at most four catch-up ticks per turn. Box3D movement events
mark bodies dirty for replication. A terminal sleep state repeats for one second
so datagram loss cannot strand a moving presentation, then the body is omitted
until another movement or wake event. Persistence captures application state
only at a completed tick boundary.

Box3D's cross-platform determinism reduces prediction error but is not a lockstep
contract. The server remains authoritative and clients always reconcile.

The prediction worker keeps authored moving-body geometry available as kinematic
collision proxies. It never promotes a prop to a client-owned dynamic body. An
authoritative sample sets a proxy's transform and velocity; pending
player-command replay advances the proxy from that state for at most 100 ms,
then freezes its motion. Replay is instantaneous and does not spend the separate
freshness lifetime: an awake proxy leaves collision only after 100 ms of actual
client time without a received sample. A terminal-sleep sample stays as a
stationary proxy. The four nearest fresh prop proxies may also drive current-time
contact presentation so the predicted player does not visibly overlap a prop
buffered in the past. They cannot receive local impulses. Only the local
geometric player controller is restored and replayed. This keeps moving support
and collision queries available without assuming that two independent
rigid-body worlds can replay stacks, contacts, other players, and constraints
identically.

The browser still loads Box3D because its controller and collision proxies use
the production geometry and queries. This is not rigid-body lockstep. Prop
presentation always originates in authoritative state: buffered tracks for
ordinary rendering, or a bounded authoritative-velocity proxy for the immediate
contact set.

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

Moving brush entities are convex hulls or compounds of convex hulls. Doors and
platforms are kinematic bodies. Triggers are sensor shapes. Loose props are
dynamic bodies. Terrain uses a static mesh unless a height field is explicitly
authored. Dynamic concave triangle meshes are forbidden.

## Player controller

The player uses Box3D's geometric capsule mover, not a dynamic rigid body.
Player lifecycle, intent policy, interaction state, controller rules, collider
dimensions, and tuning live in `packages/game`; the engine retains only generic
capsule/query primitives. The standing capsule is 1.8 m tall with a 0.35 m
radius. Server and client run the same controller code from fixed input
commands.

Each controller tick:

1. updates horizontal velocity, gravity, jump, and moving-ground velocity;
2. collects planes with `b3World_CollideMover`;
3. resolves penetration and desired displacement with `b3SolvePlanes`;
4. limits motion with `b3World_CastMover`;
5. repeats for at most five iterations with a 1 cm movement tolerance;
6. clips velocity and applies bounded reaction impulses to contacted dynamic bodies.

A fixed-tick controller result must be finite and move no more than one metre.
The server and predictor both reject a larger Box3D depenetration result, retain
the prior pose, consume the yaw/jump edge, and zero vertical velocity. This is a
safety invariant for pathological overlapping contact piles, not ordinary speed
clamping.

The authority respawns a player at `info_player_start` after it falls ten metres
below the map's lowest static collision vertex. Respawn clears held movement and
grabs, recreates the query proxy, and replicates as a teleport for one second so
the discontinuity survives state loss. A disconnected player therefore cannot
accumulate unbounded free-fall state beneath the map.

Ground is walkable through 50 degrees. The controller steps up at most 0.30 m and
snaps down at most 0.40 m while grounded. Jumping suppresses ground snapping until
vertical velocity becomes non-positive. Moving-platform point velocity is added
before movement and retained through the tick.

A kinematic proxy capsule follows the geometric mover after resolution. The proxy
exists for sensors, raycasts, projectiles, and contact identity; it does not drive
player movement. Teleport, respawn, crouch-size change, and epoch reset update the
mover and proxy atomically and clear prediction/interpolation history.
