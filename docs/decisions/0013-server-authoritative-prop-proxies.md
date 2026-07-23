# 0013: Predict the player, interpolate authoritative props

Status: accepted on 2026-07-23. Supersedes 0009.

The server is the only simulator for loose props and constrained rigid-body
interactions. The browser predicts and replays the local geometric player
controller against moving-body collision proxies. A proxy is kinematic, is
restored from the latest included transform and velocity, and may advance during
pending player replay for no more than 100 ms before freezing. Replay does not
consume its real-time freshness lifetime; an awake proxy leaves collision only
after 100 ms without a received sample. Up to four nearest proxies can replace
their older buffered render samples so the predicted player and contact surface
share one timeline. They cannot receive local impulses, and no proxy result is
sent to the server.

The superseded five-metre dynamic rollback region assumed that a partial client
Box3D island could replay the authority. It omitted remote-player contacts,
out-of-region bodies, constraints, and packet-dependent promotion boundaries.
It also let locally simulated prop poses replace authoritative presentation.
Those choices created divergent stacks and a moving temporal seam exactly where
the game needs stable shared physics.

The selected split is supported by both inspected references:

- In s&box commit
  `1a22bc7ef110feba1b8158df37377045473a5a90`, a Rigidbody proxy reads networked
  velocity rather than mutating its local physics body, model-physics proxies
  move toward networked transforms, and visual bones use lerped physics
  transforms. The simulator/owner and proxy roles are explicit.
- In Source SDK 2013 commit
  `88fa198fba3fb85d46d4c95018254693fdc3af0a`, multiplayer physics props are
  created and updated in server `props.cpp`, while the base client entity
  receives network origin/angles for interpolation. Source also distinguishes
  solid, non-solid pushable, and client-only debris modes instead of pretending
  every prop has identical multiplayer cost.

Gurgur deliberately keeps all authored gameplay props server-side. It does not
adopt s&box client ownership or Source client-only debris because map props can
participate in persistent puzzles. Their transferable lesson is that remote
proxies consume replicated state; they are not a second gameplay authority.

The transport gives the four closest props permanent 30 Hz slots. The local
player, twelve nearest remotes, and three rotating farther remotes cap player
state at 16 records so a 32-player session cannot crowd props out of the
1,200-byte packet or starve distant-player presentation. Authoritative-velocity
proxies provide current contact presentation; other nearby and far state rotates,
with priority for create, teleport, wake, and repeated terminal sleep. Per-body
history adapts between 100 and 250 ms and caps extrapolation at 100 ms. A state
blackout longer than 500 ms discards pending player replay; awake dynamic
proxies leave prediction collision after 100 ms of client time without state,
while terminal-sleep proxies remain. The shared server/client controller rejects
an implausible greater-than-one-metre single tick instead of allowing overlapping
collision geometry to launch the player.

Evidence lives in the original push, stack, domino, and corridor maps, the
authority/predictor simulation tests, the real 128-body matrix, and browser
moving-support and push scenarios.

Primary reference locations:

- [s&box Rigidbody proxy behavior](https://github.com/Facepunch/sbox-public/blob/1a22bc7ef110feba1b8158df37377045473a5a90/engine/Sandbox.Engine/Scene/Components/Collider/Rigidbody.cs)
- [s&box model-physics proxy transforms](https://github.com/Facepunch/sbox-public/blob/1a22bc7ef110feba1b8158df37377045473a5a90/engine/Sandbox.Engine/Scene/Components/Collider/ModelPhysics.Networking.cs)
- [Source multiplayer props](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/server/props.cpp)
- [Source client network transforms](https://github.com/ValveSoftware/source-sdk-2013/blob/88fa198fba3fb85d46d4c95018254693fdc3af0a/src/game/client/c_baseentity.cpp)
- [`../../apps/web/src/prediction.ts`](../../apps/web/src/prediction.ts)
- [`../../apps/server/test/prediction-network.test.ts`](../../apps/server/test/prediction-network.test.ts)
