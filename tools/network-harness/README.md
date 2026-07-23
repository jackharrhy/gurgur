# Network harness

Production-adjacent deterministic network tooling for real Gurgur clients and
servers. Production code may not depend on this package; the harness depends on
production codecs and simulation boundaries.

`UnreliableDatagramLink` shapes gameplay datagrams with independently seeded
latency, jitter, bandwidth, loss, reordering, outages, and receiver stalls.
Dropped state is never retransmitted and stale queues are never released after an
outage.

Run `bun run check`.

The integration layer opens the same WebRTC data channels as the browser, places
the deterministic shaper at the application-datagram boundary, and runs mixed
profiles against the real authoritative server while emitting structured JSON.
