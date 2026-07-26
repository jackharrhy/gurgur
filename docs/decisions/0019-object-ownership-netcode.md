# 0019: Use s&box-style per-object network authority

Status: accepted, 2026-07-26.

## Decision

Assign one simulation authority to each network object. A browser owns its
player and temporarily owns a prop under an exclusive grab lease. Bun owns
unheld objects and all fixed host systems. Nonowners treat the object as a
non-simulating proxy.

The pinned primary reference is
[Facepunch/sbox-public `GameObject.Network.cs` at `2053455813f24165d614cdeaf561082eecc86990`](https://github.com/Facepunch/sbox-public/blob/2053455813f24165d614cdeaf561082eecc86990/engine/Sandbox.Engine/Scene/GameObject/GameObject.Network.cs#L895-L961).
Its useful boundary is explicit owner identity, an `IsProxy` state for objects
simulated elsewhere, host simulation for unowned objects, transfer policy, and a
version that changes with ownership.

[Facepunch/sandbox's `GrabState` at `1cee1dd28b6de82b21afdcecdbc3f34c0047152c`](https://github.com/Facepunch/sandbox/blob/1cee1dd28b6de82b21afdcecdbc3f34c0047152c/Code/Weapons/PhysGun/Physgun.cs#L20-L68)
is used only as evidence that grab interaction state can be a compact synced
object reference, relative offset/rotation, and distance. Gurgur does not copy
the physgun controller or its ownership policy.

Gurgur's transport is protocol v5: reliable complete state for bootstrap and
authority transitions, disposable acknowledged deltas for current owner state,
100 ms proxy interpolation, and no movement prediction/reconciliation.

## Consequences

- Local movement response is independent of RTT.
- Authority transfer is explicit and testable; collision never transfers it.
- Trusted owners provide gameplay truth, fitting a cooperative social world.
- Bun remains the coordinator and durable-state owner without being the dynamic
  simulator for every object.
- Browser and host physics must share fixed-step controller policy and maintain
  non-simulating proxies for everything they do not own.
