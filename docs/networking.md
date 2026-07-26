# Networking

## Selected model

Gurgur uses per-object authority modeled on s&box network objects. A network
object owned by another peer is a proxy and is not locally simulated; an
unowned object is simulated by the host. The primary pinned reference is
[sbox-public `GameObject.Network.cs` at `2053455`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Scene/GameObject/GameObject.Network.cs#L895-L961).

[Facepunch/sandbox's pinned physgun `GrabState`](https://github.com/Facepunch/sandbox/blob/1cee1dd28b6de82b21afdcecdbc3f34c0047152c/Code/Weapons/PhysGun/Physgun.cs#L20-L68)
is an interaction-state reference only. Gurgur keeps its centre-of-mass,
obstruction-aware carry controller and does not adopt the physgun's arbitrary
hit offset or authority policy.

## Authority registry

Every runtime descriptor contains `ownerPlayerId`, `authorityVersion`, and
`transferPolicy`.

| Object                            | Initial authority | Transfer policy |
| --------------------------------- | ----------------- | --------------- |
| Network player                    | its browser       | `fixed`         |
| Dynamic grabbable map/stress prop | Bun               | `grab-lease`    |
| Unheld prop                       | Bun               | `grab-lease`    |
| Mechanism, trigger, mover, sensor | Bun               | `fixed`         |
| MCP/diagnostic actor              | Bun               | `fixed`         |

Exactly one peer simulates each object. Ordinary contact does not change the
registry.

## Fixed simulation and presentation

Bun and each browser physics worker run the Box3D adapter at 60 Hz with four
substeps. A browser runs its own geometric player controller and any granted
held prop. Bun runs unheld dynamic bodies, mechanisms, and MCP players.

Nonowners drive kinematic collision proxies from the newest accepted network
transform. Rendering is independent of proxy collision state:

- local owner states are interpolated one fixed tick behind consecutive worker
  steps;
- remote states are rendered from a 100 ms interpolation buffer;
- presentation never extrapolates beyond the newest state;
- there is no input prediction, replay, reconciliation, or correction.

## Protocol v5

Reliable WebSocket traffic carries:

- hello/welcome and WebRTC signaling;
- world manifest and complete binary bootstrap;
- lifecycle create/remove;
- ownership request, grant/denial, drop, and reliable owner discontinuity;
- use requests, reset/world replacement, speech, and ping/pong.

Disposable unordered WebRTC traffic uses two channels:

- `gurgur-owner-v5`: browser `OwnedState` and recipient `StateAck`;
- `gurgur-state-v5`: Bun-relayed `StateCluster`.

Binary state uses fixed tags, float32 transforms/controller values, presence
masks, uint16 object sequences, and generation-bearing IDs. A disposable cluster
is at most 1,200 bytes. One owner packet contains at most four objects. Bun
publishes at 30 Hz, sends only changed sequence values, splits larger updates,
coalesces obsolete pending broadcasts, and drops current-state output under
backpressure instead of queueing it reliably.

There is no spatial interest management in protocol v5. Every peer receives all
current objects.

## Delta baselines and acknowledgements

Each recipient has an acknowledged baseline per object. A cluster contains only
fields changed from that baseline. Acknowledgements identify object, authority
version, and state sequence. Unacknowledged state may be sent again after 250 ms;
newer current state supersedes older pending state.

Bootstrap, lifecycle creation, authority changes, release, respawn, and teleport
include complete reliable state. Disposable correctness never depends on a delta
arriving before its baseline.

State older than a receiver's authority version or uint16 sequence is discarded.
The same rule applies when disposable state crosses a reliable authority or
respawn message in flight.

## Grab lease

Pickup sends a reliable request containing target ID, current authority version,
hold distance, and captured relative rotation. Bun validates:

- current `worldEpoch`;
- generation-bearing target identity;
- `grab-lease` policy and no current owner;
- exact authority version;
- bounded finite hold values;
- distance from the latest accepted player proxy.

The first valid request changes owner and authority version atomically and
includes complete prop state. The browser converts its proxy to a dynamic body
and starts the shared carry controller.

Release sends one reliable complete pose plus linear/angular velocity. The
browser immediately converts back to a proxy. Bun applies the final state,
increments authority version, resumes dynamic simulation, and broadcasts the
atomic change. Held props cannot be stolen.

## Validation and recovery

Owner datagrams are accepted only from the current owner and exact authority
version. Values must be finite and within the 10 km world envelope; velocity is
bounded before host use. Codecs cap message size and object count, the control
WebSocket caps payloads, and owner traffic is limited to 120 datagrams per
second per connection.

On transport loss Bun immediately reclaims every held prop from its last
accepted state. The disconnected player proxy remains frozen for the ten-second
session grace. Reconnect assigns the same player a new authority version.
Grace expiry despawns and persists the player.

Falling below the world void respawns in the owner worker and sends a reliable
complete owner commit. Global reset increments `worldEpoch`, revokes leases,
rebuilds all physics worlds, and reassigns connected players.

## Host coordination

Spawning, deletion, mechanisms, persistence, session identity, speech identity,
use validation, and reset are host-coordinated. Reliable `use` requests are
validated against the latest accepted player position and target reach.

Gurgur trusts the current owner as gameplay truth. Validation prevents malformed,
stale, unowned, oversized, or grossly out-of-world state; it is not competitive
anti-cheat.
