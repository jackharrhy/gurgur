import { describe, expect, test } from "bun:test";
import { UnreliableDatagramLink, type NetworkProfile } from "../src/unreliable-datagram-link";

const profile: NetworkProfile = {
  name: "test",
  roundTripLatencyMs: 100,
  jitterMs: 40,
  lossRate: 0.2,
  maxPacketLifetimeMs: 200,
  bandwidthBitsPerSecond: 1_000_000,
};

describe("UnreliableDatagramLink", () => {
  test("is seeded, drops without retransmission, and permits reordering", () => {
    const run = () => {
      const link = new UnreliableDatagramLink<number>(profile, 42);
      for (let sequence = 0; sequence < 100; sequence += 1) link.send(sequence, 100, sequence);
      return {
        delivered: link.advance(1_000).map(({ payload }) => payload),
        metrics: link.metrics,
      };
    };
    const first = run();
    expect(run()).toEqual(first);
    expect(first.metrics.droppedPackets).toBeGreaterThan(0);
    expect(first.metrics.deliveredPackets + first.metrics.droppedPackets).toBe(100);
    expect(
      first.delivered.some((value, index) => index > 0 && value < first.delivered[index - 1]!),
    ).toBe(true);
  });

  test("drops packets during outages and receiver stalls instead of releasing a stale queue", () => {
    const link = new UnreliableDatagramLink<string>({ ...profile, jitterMs: 0, lossRate: 0 }, 1);
    link.addOutage(100, 200);
    link.pauseReceiverUntil(80);
    link.send(0, 50, "paused");
    link.send(120, 50, "outage");
    link.send(220, 50, "fresh");
    expect(link.advance(1_000).map(({ payload }) => payload)).toEqual(["fresh"]);
    expect(link.metrics.droppedPackets).toBe(2);
  });
});
