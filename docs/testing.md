# Testing and simulation harnesses

Testing infrastructure is part of the production architecture. Every stateful
subsystem has deterministic controls, metrics, and a headless path so transport,
simulation, prediction, and presentation failures remain distinguishable.

`bun run check` runs formatting, lint, TypeScript, unit/contract/simulation tests,
the real server integration suite, and shutdown/configuration integration.
Generated bundles, reports, runtime data, and TrenchBroom autosaves are ignored;
authored fixtures and tests are not.

## Layers

| Layer       | Purpose                                                               |
| ----------- | --------------------------------------------------------------------- |
| Unit        | codecs, quantization, datagram shaping, handles, map parsing, storage |
| Contract    | protocol unions, transport channels, adapter ownership                |
| Simulation  | fixed-tick authoritative and predicted interaction scripts            |
| Multiplayer | real server, real WebRTC peers, shaped datagrams, many clients        |
| Browser     | worker prediction, WebRTC session, Three.js presentation, input       |
| Soak        | physics churn, connection churn, persistence, reset, long-run drift   |

There are no skipped networking or physics tests. A player-visible regression
belongs at the lowest layer that reproduces it and in a browser scenario when
the failure is visual.

## Authored network-physics fixtures

Fixtures compile through the production Valve 220 compiler and typed entity
schema:

- `network-boxes.map` covers sustained pushing and stacked support;
- `network-push-corridor.map` contrasts a light pushable prop with a heavy prop;
- `network-stack-tower.map` exercises propagation and terminal sleep through a
  five-body vertical stack;
- `network-domino-field.map` exercises chained wake/contact/sleep transitions.

Simulation tests settle each map, assert finite state throughout, verify that
only the authority moves props, exercise latest-wins intent and action counters,
measure near/far cadence, drop terminal sleep samples, persist/restart, and reset
runtime generations. Prediction tests restore and replay only the player against
authoritative kinematic prop proxies; current contact presentation may use those
proxies, but player contact cannot apply local rigid-body motion to them.

Browser scenarios run the actual Bun server, WebSocket signaling, WebRTC data
channels, codecs, prediction worker, Box3D Wasm, Three.js renderer, and input
path. `test:browser -- dynamic` covers moving support, `-- push` covers visible
prop response under shaped latency, `-- latency` covers held input, and the other
scenarios cover grab, touch, gamepad, reconnect, and ordinary movement. Browser
automation appends `?test`; the grab scenario also enables the general `?debug`
view and requires a non-empty authoritative Box3D debug frame, covering the server
callback, JSON route, browser polling, and Three.js overlay together.

## Multiplayer harness

The harness launches the real child-process server and connects real `werift`
peers. It does not replace WebRTC with a mock socket. Each direction then passes
application datagrams through an independently seeded shaper that applies
latency, jitter, random loss, bandwidth serialization, reordering, packet
lifetime expiry, outages, and receiver stalls. Expired packets are dropped;
there is no synthetic retransmission queue.

The baseline has 16 moving players and 128 authoritative dynamic bodies. Runs at
2, 8, 16, and 32 peers cover scaling; dedicated runs cover a five-second outage,
receiver stall, and connected epoch reset. All clients exercise signaling,
codecs, input redundancy, acknowledgement, interpolation, and epoch checks. One
client per profile also runs the full Box3D predictor, avoiding the false
receiver stall caused by advancing sixteen 128-proxy prediction worlds on one
test-process thread.

Reports include seed, build and map revision, world epoch, server tick, client
identity, input acknowledgement, state age, prediction correction, shaped drops,
queue high-water marks, server state drops, fixed-tick cost, and contact-proxy
extrapolation-cap overruns.

## Profiles

| Profile     |    RTT | Jitter | Loss |  Bandwidth |
| ----------- | -----: | -----: | ---: | ---------: |
| Local       |   2 ms |   0 ms |   0% |  unlimited |
| Typical     |  80 ms |  20 ms |   1% |  10 Mbit/s |
| Adverse     | 150 ms |  40 ms |   5% |   1 Mbit/s |
| Constrained | 250 ms |  80 ms |   8% | 256 Kbit/s |

Local, Typical, and Adverse are quality profiles. Constrained intentionally sits
below the 30 Hz stress-world state rate and is a saturation/recovery profile, not
part of a blended quality headline.

## Budgets

Prediction error is raw authority-to-predictor correction before the 100 ms
display decay. Explicit teleport, respawn, and epoch discontinuities clear replay
and are not counted as prediction error. The 128-body stress world deliberately
drives clients through dense authoritative prop contacts, so prediction and
transport have separate budgets:

| Profile | Prediction p95 | Prediction p99 | Prediction max | State age p95 | Input ack p95 |
| ------- | -------------: | -------------: | -------------: | ------------: | ------------: |
| Local   |         1.25 m |          1.5 m |          2.0 m |         50 ms |        100 ms |
| Typical |          1.5 m |          2.0 m |          2.5 m |        150 ms |        250 ms |
| Adverse |          2.0 m |          3.0 m |          3.5 m |        250 ms |        400 ms |

The larger poor-network prediction bounds describe a pathological contact pile,
not permission for stale transport. State age and acknowledgement stay close to
the shaped path, the server state queue remains at or below two 1,200-byte
datagrams, and the gated 16-peer run permits no server-side state drops.

Additional gates are:

- 60 Hz server work stays below 8 ms p95 and 12 ms p99 at 16 peers/128 props;
- no current-time contact proxy retains nonzero linear or angular velocity more
  than 100 ms after the client received its last authoritative sample;
- a state gap over 500 ms discards stale player replay, and no accepted predicted
  tick moves the player more than one metre;
- the minimal push fixture keeps player/proxy alignment within 1 cm and measured
  penetration below 6 mm; stacked support stays within 6 cm;
- the browser push view allows at most 3.5 cm of presented capsule/prop overlap;
- a five-second outage never exceeds a 15 m raw partition-heal correction and
  recovers the affected Local client below 1.75 m correction and 50 ms state age
  within the final one-second window;
- a Typical receiver stall recovers below 1.5 m correction and 150 ms state age;
- reset/reconnect leaves no old-epoch input, track, prediction, or runtime handle;
- every scenario ends with zero correctness errors.

Changing a budget requires a decision record or canonical requirement update,
never a weakened assertion hidden in a test.

## Commands

```sh
bun run check
bun run test:network -- single
bun run test:network -- matrix --quick
bun run test:browser -- all
bun run soak -- physics
bun run soak -- connections
bun run soak -- persistence
```
