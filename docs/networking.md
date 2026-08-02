# Networking

## Selected model

Gurgur keeps explicit per-object authority modeled on s&box network objects,
but centralizes every shared rigid body in Bun. A browser owns only its
geometric player controller. Bun dynamically simulates every shared prop,
mechanism, mover, and diagnostic body in one Box3D world. Browsers represent
those objects with non-simulating proxies.

The pinned authority reference is
[sbox-public `GameObject.Network.cs` at `2053455`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Scene/GameObject/GameObject.Network.cs#L895-L961).
[Facepunch/sandbox's pinned physgun `GrabState`](https://github.com/Facepunch/sandbox/blob/1cee1dd28b6de82b21afdcecdbc3f34c0047152c/Code/Weapons/PhysGun/Physgun.cs#L20-L68)
is the target-control reference. Loose props use a centre-of-mass anchor;
contraptions use the selected hit offset. Both are pulled by a Bun-created
control joint without transferring authority.

## Authority registry

Every runtime descriptor contains `ownerPlayerId`, `authorityVersion`, and the
single protocol-v6 transfer policy `fixed`.

| Object                            | Authority   | Transfer policy |
| --------------------------------- | ----------- | --------------- |
| Network player                    | its browser | `fixed`         |
| Held or unheld loose prop         | Bun         | `fixed`         |
| Mechanism, trigger, mover, sensor | Bun         | `fixed`         |
| Joint-connected body/contraption  | Bun         | `fixed`         |
| MCP/diagnostic actor              | Bun         | `fixed`         |

Exactly one peer dynamically simulates each object. Ordinary contact never
changes the registry. A browser-authored body state is invalid protocol input.

## Fixed simulation, time, and presentation

Bun and each browser physics worker run the Box3D adapter at 60 Hz with four
substeps. A browser runs only its own geometric player controller. Bun runs all
shared dynamic bodies, mechanisms, and MCP players.

Every network object state carries an unsigned 32-bit `sourceTick`.
Bun-produced state uses `serverTick`. Bun maps browser-player ticks onto its
clock once per player authority version with an immutable epoch offset. Packet
delay can neither stretch nor compress the mapped source cadence. A mapped tick
may lead the current host tick by at most twelve ticks to absorb a lower-delay
packet after the initial anchor; backwards or larger future jumps are rejected.
Tick rollover is unwrapped against each object's existing timeline.

Nonowners buffer source-tick samples. At each fixed step they move collision
proxies through Box3D kinematic target transforms, including rotation, from a
eight-tick host timeline. Bun applies the same delayed timeline to externally
owned player proxies before shared-body contacts. Packet callbacks do not
teleport ordinary collision proxies.

Rendering is separate from collision state:

- local player states are interpolated one fixed tick behind worker steps;
- ordinary remote render tracks adapt independently between four and eight
  source ticks from recent late-arrival and underrun evidence;
- delay rises without moving the render timeline backwards and falls slowly
  after a two-second underrun hold;
- presentation never extrapolates beyond the newest state;
- reliable respawn, reset, and authority discontinuities replace the timeline;
- there is no gameplay input prediction, replay, reconciliation, or rigid-body
  extrapolation;
- after a reliable loose-prop claim grant, only the claimant's rendered mesh may
  follow the local 60 Hz target speculatively and reconcile visually on release.

The fixed eight-tick browser collision track and Bun player-proxy track never
read the adaptive render delay or the speculative held view. The latter cannot
enter collision queries, trigger decisions, persistence, use validation, or an
outbound body-state packet.

The player/body contract is deliberately one-way. The browser's geometric
player treats remote bodies as kinematic collision geometry. Bun's delayed
kinematic player proxy can push Bun-owned bodies. A future requirement for
reciprocal authoritative player/body response requires a different,
Source-style server-player authority and prediction decision.

## Protocol v6

Reliable WebSocket traffic carries:

- hello/welcome and WebRTC signaling;
- world manifest and complete binary bootstrap;
- lifecycle create/remove;
- reliable player authority assignment and owner discontinuity;
- fixed-authority prop manipulation request, grant/denial, and drop;
- use requests, reset/world replacement, speech, and ping/pong.

Disposable unordered WebRTC traffic uses two channels:

- `gurgur-owner-v6`: browser player `OwnedState`, recipient `StateAck`, and
  fixed 51-byte `ManipulationState` targets;
- `gurgur-state-v6`: Bun-relayed `StateCluster`.

Binary state uses fixed tags, float32 transforms/controller values, presence
masks, uint16 object sequences, uint32 source ticks, and generation-bearing
IDs. A disposable cluster is at most 1,200 bytes. Bun accepts exactly one
browser-owned state: the sending browser's player. Ordinary Bun state publishes
at 30 Hz; a currently manipulated body is a 60 Hz hot state. Replication sends
only changed sequence values, splits larger updates, coalesces obsolete pending
broadcasts, and drops current-state output under backpressure instead of
queueing it reliably.

There is no spatial interest management in protocol v6. Every peer receives all
current objects.

Joint definitions, mapper classnames, and gravity-volume overlap state are not
protocol concepts. Jointed bodies replicate as ordinary fixed-authority body
state. Conveyors reserve the body-state `active` and `reversed` flags. Browser
workers evaluate immutable conveyor and gravity capabilities for their player;
Bun evaluates them for every shared body.

## Delta baselines and acknowledgements

Each recipient has an acknowledged baseline per object. A cluster contains only
fields changed from that baseline. Acknowledgements identify object, authority
version, and state sequence. Unacknowledged state may be sent again after
250 ms; newer current state supersedes older pending state.

Bootstrap, lifecycle creation, player authority change, respawn, and teleport
include complete reliable state. Disposable correctness never depends on a
delta arriving before its baseline.

State older than a receiver's authority version or uint16 sequence is
discarded. `authorityVersion`, `stateSequence`, `sourceTick`, `worldEpoch`,
`mapRevision`, and persistence version remain independent.

## Fixed-authority prop manipulation

Every `func_physics` remains dynamically simulated by Bun while held. A primary
press sends a reliable request containing target identity, current authority
version, body-local anchor, and hold distance. A loose `grab` uses the centre of
mass and derives stable distance from compiled extent. A `manipulate`
interaction uses the selected hit offset.

Bun validates epoch, exact version, fixed policy, compiled capability, finite
values, reach, and claim availability. One player and one body may participate
in at most one claim; the first valid request wins.

The browser never publishes a body transform. At 60 Hz while claimed it sends a disposable
target containing claim version, uint16 target sequence, desired world anchor,
and desired rotation. Bun accepts it only from the claimant at the current
object and claim versions, then applies it to a private native control joint.
The Bun-owned body state is the only replicated physics result and is published
as a 60 Hz hot state for the duration of manipulation.

Release is reliable and removes the control joint without an authority, body
type, or solver change. Existing velocity continues in the same world. Missing
target state times out after 1.5 seconds. Transport loss, respawn, lifecycle
removal, and reset release immediately. The held flag controls interaction
availability; claim version is independent of `authorityVersion`. A claimant's
presentation-only loose-prop view retains its last visual offset at release and
converges to the authoritative render track with correction capped at 2 m/s and
2π rad/s; this is not a physics handoff.

## Validation and recovery

Owner datagrams are accepted only for the sending browser's player at the exact
authority version. Values must be finite and within the 10 km world envelope.
Codecs cap message size and object count, the control WebSocket caps payloads,
and owner traffic is limited to 120 datagrams per second per connection.

On transport loss Bun removes that player's manipulation claim; no body
takeover or handoff occurs. The disconnected player proxy remains frozen for
the ten-second session grace. Reconnect assigns the same player a new authority
version. Grace expiry despawns and persists the player.

Falling below the void respawns in the owner worker and sends a reliable
complete owner commit. Global reset increments `worldEpoch`, revokes claims,
rebuilds all physics worlds, and reassigns connected players.

## Host coordination

Spawning, deletion, mechanisms, persistence, session identity, speech identity,
use validation, manipulation claims, and reset are host-coordinated. Reliable
`use` requests are validated against the latest accepted player position and
target reach.

Gurgur trusts browser player state as cooperative gameplay truth. Validation
prevents malformed, stale, unowned, oversized, or grossly out-of-world state;
it is not a competitive anti-cheat boundary.
