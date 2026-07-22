import type { NetworkProfile } from "./reliable-ordered-link";

export const NETWORK_PROFILES = {
  local: {
    name: "local",
    roundTripLatencyMs: 2,
    jitterMs: 0,
    lossRate: 0,
    retransmitDelayMs: 4,
    bandwidthBitsPerSecond: null,
  },
  typical: {
    name: "typical",
    roundTripLatencyMs: 80,
    jitterMs: 20,
    lossRate: 0.01,
    retransmitDelayMs: 120,
    bandwidthBitsPerSecond: 10_000_000,
  },
  adverse: {
    name: "adverse",
    roundTripLatencyMs: 150,
    jitterMs: 40,
    lossRate: 0.05,
    retransmitDelayMs: 225,
    bandwidthBitsPerSecond: 1_000_000,
  },
  constrained: {
    name: "constrained",
    roundTripLatencyMs: 250,
    jitterMs: 80,
    lossRate: 0.08,
    retransmitDelayMs: 375,
    bandwidthBitsPerSecond: 256_000,
  },
} as const satisfies Record<string, NetworkProfile>;
