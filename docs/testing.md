# Testing

`bun run check` runs formatting, lint, TypeScript, unit/simulation tests,
persistence/content tests, and the real Bun/WebRTC protocol-v5 integration
suite.

## Network commands

- `bun run test:network` runs the 16-player/128-prop release matrix.
- `bun run test:network -- --quick` runs a six-client development matrix.
- `bun run test:network stress` reports 32 players/256 props without blocking a
  release.
- `bun run test:browser` runs real Chrome movement/banding, pickup/release,
  simultaneous contention, disconnect takeover, and connected-reset scenarios.
  It also loads the contraption fixture, verifies every procedural constraint
  visual, pulls a fixed-authority lever through the host control joint, and
  confirms that the body never gains a client owner.
- `bun run test:browser movement|pickup|contention` selects one browser scenario.

The transport harness uses a real Bun server and real unordered WebRTC data
channels. Seeded impairment layers apply these end-to-end profiles:

| Profile |    RTT | Jitter | Loss |
| ------- | -----: | -----: | ---: |
| Local   |   2 ms |   0 ms |   0% |
| Typical |  80 ms |  20 ms |   1% |
| Adverse | 150 ms |  40 ms |   5% |

## Release budgets

The 16-player/128-prop gate requires:

- local and Typical remote objects advance on at least 95% of eligible render
  frames at both 60 Hz and 120 Hz;
- remote state age p95 below 200 ms Typical and 300 ms Adverse;
- average state traffic below 2 Mbit/s per recipient;
- zero stale-authority acceptance;
- release handoff discontinuity below 5 cm;
- host simulation tick below 8 ms p95 and 12 ms p99.

The real-browser local movement gate measures input-edge to presented owner state
and requires no more than one fixed worker tick plus the next render frame. The
browser suite also verifies first-grabber-wins, carry/turn/release, reliable or
disconnect-backed release recovery, disconnect while holding, and a connected
epoch reset.

Focused codec tests cover bounds, full bootstrap, acknowledged baselines,
250 ms resend, sequence wrap, loss, duplication, and reordering. Host ownership
tests cover denial, no contact transfer, stale owner state, release velocity,
disconnect takeover, reconnect reassignment, reset, and the host tick budget.
Manipulation tests separately cover the fixed 51-byte codec, first-claim-wins,
foreign and stale target rejection, sequence wrap, disconnect cleanup, held-flag
availability, native control motion, and stale constraint handles.

Contraption tests cover every mapper classname and generated FGD choice,
map-unit/axis conversion, exact-one attachment resolution, authored local
frames, and rejection of grabbable joint graphs. Deterministic adapter tests
exercise joint motors/limits, stale handles, compound conveyor materials,
multi-shape sensors, and gravity scale. Simulation tests cover compound overlap
reference counts, gravity priority/restoration, device inputs, persistence, and
replicated active/reversed flags. The dedicated
`physics-contraptions.map` fixture is the executable authoring catalogue.
It also verifies default constraint presentation styles, `renderable 0`, and
fixed bodies compiling as manipulable rather than grab-leased.
