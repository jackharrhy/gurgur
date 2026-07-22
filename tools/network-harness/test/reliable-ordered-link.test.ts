import { describe, expect, test } from "bun:test";
import { NETWORK_PROFILES, ReliableOrderedLink } from "../src";

describe("ReliableOrderedLink", () => {
  test("is reproducible from a seed", () => {
    const run = () => {
      const link = new ReliableOrderedLink(NETWORK_PROFILES.adverse, 1234);
      for (let index = 0; index < 100; index += 1) link.send(index * 10, 64, index);
      return link.advance(60_000);
    };
    expect(run()).toEqual(run());
  });

  test("models loss as retransmission rather than application packet loss", () => {
    const link = new ReliableOrderedLink({
      ...NETWORK_PROFILES.typical,
      lossRate: 1,
      retransmitDelayMs: 200,
    }, 1);
    link.send(0, 20, "first");
    link.send(1, 20, "second");

    expect(link.advance(100)).toEqual([]);
    expect(link.advance(1_000).map((packet) => packet.payload)).toEqual(["first", "second"]);
    expect(link.metrics.retransmissions).toBe(2);
    expect(link.metrics.deliveredPackets).toBe(2);
  });

  test("serializes packets through a bandwidth-limited ordered link", () => {
    const link = new ReliableOrderedLink({
      ...NETWORK_PROFILES.local,
      roundTripLatencyMs: 0,
      bandwidthBitsPerSecond: 1_000,
    }, 2);
    link.send(0, 100, "first");
    link.send(0, 100, "second");
    const packets = link.advance(2_000);

    expect(packets[0]!.deliveryAtMs).toBe(800);
    expect(packets[1]!.deliveryAtMs).toBe(1_600);
    expect(link.metrics.queueHighWaterBytes).toBe(200);
    expect(link.metrics.queuedBytes).toBe(0);
  });

  test("applies outages and receiver backpressure without reordering", () => {
    const link = new ReliableOrderedLink(NETWORK_PROFILES.local, 3);
    link.addOutage(10, 5_010);
    link.send(10, 10, 0);
    link.send(20, 10, 1);
    link.pauseReceiverUntil(6_000);

    expect(link.advance(5_999)).toEqual([]);
    const delivered = link.advance(6_000);
    expect(delivered.map((packet) => packet.sequence)).toEqual([0, 1]);
  });

  test("supports sixteen independently seeded client links", () => {
    const traces = Array.from({ length: 16 }, (_, clientId) => {
      const profile = clientId % 4 === 0 ? NETWORK_PROFILES.constrained : NETWORK_PROFILES.typical;
      const link = new ReliableOrderedLink(profile, 10_000 + clientId);
      for (let packet = 0; packet < 60; packet += 1) {
        link.send(packet * (1000 / 60), 48, { clientId, packet });
      }
      const delivered = link.advance(60_000);
      expect(delivered).toHaveLength(60);
      return delivered.map((packet) => packet.deliveryAtMs);
    });

    expect(new Set(traces.map((trace) => JSON.stringify(trace))).size).toBe(16);
  });
});
