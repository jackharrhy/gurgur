# 0009: Predict the local dynamic-contact region

Status: superseded by 0013 on 2026-07-23.

Keep the server authoritative while speculatively advancing the local player and
nearby dynamic bodies with the shared fixed-step Box3D implementation. Render
that local region near predicted current time. Continue rendering unrelated
players and bodies from delayed authoritative snapshot history.

The previous split predicted the local capsule against kinematic copies of every
moving brush. Controller reaction impulses therefore could not move a pushed
box, while presentation combined the current local capsule with a box rendered
150 ms in the past. That temporal seam allowed visible overlap even when the
authoritative collision result was valid.

The selected design is a bounded clean-room adaptation of established game
networking patterns:

- QuakeWorld and Quake III replay local movement commands from authoritative
  snapshots rather than treating the client transform as truth.
- Source predicts the local player, deliberately interpolates unrelated remote
  state in the past, and treats lag compensation for attacks as a separate
  server-rewind concern.
- Networked rigid-body guidance recommends shared fixed-step prediction plus
  authoritative state synchronization rather than assuming cross-machine
  lockstep.

For Gurgur, sparse snapshots include complete same-tick state for dynamic bodies
within five metres of a player. The predictor promotes only those bodies to
dynamic, restores them with the player, applies controller impulses before the
fixed physics step, and replays unacknowledged commands. Bodies outside that
region remain cheap non-simulated proxies. This is intentionally narrower than
general rigid-body rollback and does not grant the client authority over
transforms, contacts, grabs, or gameplay results.

Primary references are the [QuakeWorld prediction
loop](https://github.com/id-Software/Quake/blob/master/QW/client/cl_pred.c),
[Quake III prediction](https://github.com/id-Software/Quake-III-Arena/blob/master/code/cgame/cg_predict.c),
[Source multiplayer networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking),
[Yahn Bernier's latency-compensation paper](https://developer.valvesoftware.com/wiki/Latency_Compensating_Methods_in_Client/Server_In-game_Protocol_Design_and_Optimization),
and Glenn Fiedler's [networked physics](https://gafferongames.com/post/networked_physics_2004/)
and [state synchronization](https://gafferongames.com/post/state_synchronization/)
articles. Quake code is GPLv2 and the Source SDK has restricted terms, so these
sources inform behavior and testing only; Gurgur does not copy their code.

Evidence lives in
[`../../content/maps/fixtures/network-boxes.map`](../../content/maps/fixtures/network-boxes.map),
[`../../apps/server/test/prediction-network.test.ts`](../../apps/server/test/prediction-network.test.ts),
and the `dynamic-push` real-browser smoke scenario.
