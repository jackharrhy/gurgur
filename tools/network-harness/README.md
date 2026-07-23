# Network harness

Production-adjacent deterministic network tooling for real Gurgur clients and
servers. Production code may not depend on this package; the harness depends on
production codecs and simulation boundaries.

`ReliableOrderedLink` models the selected WebSocket semantics with independently
seeded latency, jitter, bandwidth, retransmission stalls, outages, and receiver
backpressure. It never turns simulated TCP loss into silent application-packet
loss.

Run `bun run check`.

The next integration layer connects two directional links to a headless client,
then runs 16 mixed-profile clients against the real authoritative server while
emitting the budgets defined in `docs/testing.md` as structured JSON.
