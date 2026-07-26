# 0015: Index prediction by simulation tick and schedule state by delivery history

Status: accepted and amended on 2026-07-25. Refines 0012 and 0013.

Gurgur keeps disposable latest-intent input and self-contained current-state
datagrams, but neither packet count nor instantaneous priority stands in for
simulation or delivery history.

The local controller records one effective intent and result per predicted
server tick. Authority at tick `S` restores that tick and replays later recorded
ticks exactly once. Input sequence acknowledgement remains transport metadata;
it does not decide how many fixed steps to replay. This preserves the server's
newest-wins intent model instead of incorrectly borrowing the ordered-command
assumption from Source-style prediction.

The browser's estimated current server tick, not an input timer callback, clocks
those prediction steps. Input sampling uses absolute deadlines, while repeated
callbacks targeting one estimated server tick only replace the held intent. A
real trace exposed why this distinction is necessary: a nominal
`setInterval(1000 / 60)` ran at 62.27 Hz against a 59.99 Hz server. Prediction
treated every callback as a tick, growing from 35 replayed frames to 63 in 12.6
seconds and presenting the local player as much as 4.75 m ahead. Input packet
production and fixed simulation time are therefore separate even when both
normally operate near 60 Hz.

Snapshot tick `S` names the completed post-step state at `S`; it is not the
interval about to be simulated. A later local trace delivered all 451 snapshots
with sub-4-ms RTT yet showed an exact 0.083333 m correction at 5 m/s whenever
prediction targeted `floor(estimated tick)`. In 123 of 136 material corrections,
the pre-reconciliation pose matched server tick `S - 1` better than `S`.
Prediction therefore targets `floor(estimated tick) + 1`. Rendering keeps the
completed tick labels and samples their fractional server phase. Arrival-relative
one-frame easing is rejected because it delays already phase-correct poses;
immediately showing the entire next-tick pose is also rejected because it leads
fast player and prop motion by as much as one fixed step.

Each connection also owns a coalescing body-state scheduler. Held and recently
released bodies use an eight-record fast lane, nearby awake state has a
two-snapshot deadline, transition and terminal-sleep commits are capped at four
records, and remaining state accumulates importance until selected. Protocol v3
piggybacks the latest received state tick and a selective 32-tick mask on
redundant input bundles. The scheduler uses that receipt evidence only to retire
a delivered terminal sleeping revision. It never queues an ordered state delta
chain, and newer body state replaces older unsent state.

Rendering and prediction collision consume the same fresh proxy set. Once an
awake proxy exceeds its 100 ms receipt lifetime, it cannot remain in
current-contact presentation after leaving collision.

The rejected implementation filtered replay by
`lastProcessedInputSequence` and selected props from a stateless set of
create/teleport/wake/sleep/grab flags. A captured local interaction showed both
failures: player corrections had an exact one-fixed-tick displacement signature,
while 27 repeated sleeping transitions consumed state capacity and left the
thrown cube stale for roughly 233 ms.

The focused regression independently phases client sampling, server ticks, input
delivery, and snapshot delivery; deterministically forces zero- and
multi-sequence acknowledgement
advances; and round-trips the production codecs. A second case grabs, carries,
turns, releases, and throws the authored 0.8128 m cube with 32 additional bodies
competing for state. Scheduler tests prove release priority, awake freshness,
bounded sleep commits, and acknowledgement-driven silence. The required check
gate also launches the production page in Chromium against a real Bun server,
waits 6.5 seconds for clock-rate errors to accumulate, then requires predicted
and authoritative movement to remain within 0.25 m through the actual input,
worker, WebRTC, codec, and backend path.

Prior-art evidence:

- [Valve latency compensation](https://developer.valvesoftware.com/w/index.php?title=Latency_Compensating_Methods_in_Client%2FServer_In-game_Protocol_Design_and_Optimization&uselang=en)
  documents ordered command replay, whose exactly-once assumption Gurgur does
  not adopt.
- [Unity command streams](https://docs.unity.cn/Packages/com.unity.netcode%401.0/manual/command-stream.html)
  and [prediction](https://docs.unity.cn/Packages/com.unity.netcode%401.10/manual/prediction-n4e.html)
  key simulation work to network ticks.
- [Unreal networked physics](https://dev.epicgames.com/documentation/unreal-engine/networked-physics-overview)
  compares and resimulates matching physics frames.
- Glenn Fiedler's [state synchronization](https://www.gafferongames.com/post/state_synchronization/)
  accumulates priority for unsent objects, and
  [networked VR physics](https://gafferongames.com/post/networked_physics_in_virtual_reality/)
  elevates recently interacted rigid bodies.

Production evidence:

- [`../../apps/web/src/prediction.ts`](../../apps/web/src/prediction.ts)
- [`../../apps/web/src/input.ts`](../../apps/web/src/input.ts)
- [`../../apps/server/src/snapshot-scheduler.ts`](../../apps/server/src/snapshot-scheduler.ts)
- [`../../apps/server/test/network-phase-regression.test.ts`](../../apps/server/test/network-phase-regression.test.ts)
- [`../../apps/server/test/snapshot-scheduler.test.ts`](../../apps/server/test/snapshot-scheduler.test.ts)
- [`../../scripts/smoke-browser.ts`](../../scripts/smoke-browser.ts)
