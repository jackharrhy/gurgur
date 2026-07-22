export type NetworkProfile = {
  name: string;
  roundTripLatencyMs: number;
  jitterMs: number;
  lossRate: number;
  retransmitDelayMs: number;
  bandwidthBitsPerSecond: number | null;
};

export type DeliveredPacket<T> = {
  sequence: number;
  payload: T;
  byteLength: number;
  sentAtMs: number;
  deliveryAtMs: number;
  retransmitted: boolean;
};

export type LinkMetrics = {
  sentPackets: number;
  deliveredPackets: number;
  retransmissions: number;
  sentBytes: number;
  deliveredBytes: number;
  queuedBytes: number;
  queueHighWaterBytes: number;
};

type Outage = { startMs: number; endMs: number };

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export class ReliableOrderedLink<T> {
  readonly profile: NetworkProfile;
  readonly seed: number;

  #random: () => number;
  #nextSequence = 0;
  #transmitterAvailableAtMs = 0;
  #orderedDeliveryFloorMs = 0;
  #pending: Array<DeliveredPacket<T>> = [];
  #outages: Outage[] = [];
  #metrics: LinkMetrics = {
    sentPackets: 0,
    deliveredPackets: 0,
    retransmissions: 0,
    sentBytes: 0,
    deliveredBytes: 0,
    queuedBytes: 0,
    queueHighWaterBytes: 0,
  };

  constructor(profile: NetworkProfile, seed: number) {
    if (profile.roundTripLatencyMs < 0 || profile.jitterMs < 0)
      throw new Error("latency and jitter must be non-negative");
    if (profile.lossRate < 0 || profile.lossRate > 1)
      throw new Error("lossRate must be between zero and one");
    if (profile.retransmitDelayMs < 0) throw new Error("retransmitDelayMs must be non-negative");
    if (profile.bandwidthBitsPerSecond !== null && profile.bandwidthBitsPerSecond <= 0) {
      throw new Error("bandwidth must be positive or null");
    }
    this.profile = { ...profile };
    this.seed = seed >>> 0;
    this.#random = mulberry32(this.seed);
  }

  addOutage(startMs: number, endMs: number) {
    if (!(startMs >= 0 && endMs > startMs)) throw new Error("invalid outage interval");
    this.#outages.push({ startMs, endMs });
    this.#outages.sort((left, right) => left.startMs - right.startMs);
  }

  pauseReceiverUntil(untilMs: number) {
    if (untilMs < 0) throw new Error("pause deadline must be non-negative");
    let floor = untilMs;
    for (const packet of this.#pending) {
      packet.deliveryAtMs = Math.max(packet.deliveryAtMs, floor);
      floor = packet.deliveryAtMs;
    }
    this.#orderedDeliveryFloorMs = Math.max(this.#orderedDeliveryFloorMs, floor);
  }

  send(sentAtMs: number, byteLength: number, payload: T) {
    if (sentAtMs < 0 || !Number.isFinite(sentAtMs))
      throw new Error("sentAtMs must be finite and non-negative");
    if (!Number.isInteger(byteLength) || byteLength < 0)
      throw new Error("byteLength must be a non-negative integer");

    const transmissionStart = Math.max(sentAtMs, this.#transmitterAvailableAtMs);
    const serializationMs =
      this.profile.bandwidthBitsPerSecond === null
        ? 0
        : (byteLength * 8 * 1000) / this.profile.bandwidthBitsPerSecond;
    const transmissionEnd = transmissionStart + serializationMs;
    this.#transmitterAvailableAtMs = transmissionEnd;

    const jitter =
      this.profile.jitterMs === 0 ? 0 : (this.#random() * 2 - 1) * this.profile.jitterMs;
    const retransmitted = this.#random() < this.profile.lossRate;
    let deliveryAtMs =
      transmissionEnd +
      this.profile.roundTripLatencyMs / 2 +
      jitter +
      (retransmitted ? this.profile.retransmitDelayMs : 0);
    deliveryAtMs = Math.max(transmissionEnd, deliveryAtMs);

    for (const outage of this.#outages) {
      if (deliveryAtMs >= outage.startMs && deliveryAtMs < outage.endMs) {
        deliveryAtMs = outage.endMs + this.profile.roundTripLatencyMs / 2;
      }
    }

    // TCP/WebSocket delivery is ordered: a delayed segment stalls all later data.
    deliveryAtMs = Math.max(deliveryAtMs, this.#orderedDeliveryFloorMs);
    this.#orderedDeliveryFloorMs = deliveryAtMs;

    const packet: DeliveredPacket<T> = {
      sequence: this.#nextSequence++,
      payload,
      byteLength,
      sentAtMs,
      deliveryAtMs,
      retransmitted,
    };
    this.#pending.push(packet);

    this.#metrics.sentPackets += 1;
    this.#metrics.sentBytes += byteLength;
    this.#metrics.queuedBytes += byteLength;
    this.#metrics.queueHighWaterBytes = Math.max(
      this.#metrics.queueHighWaterBytes,
      this.#metrics.queuedBytes,
    );
    if (retransmitted) this.#metrics.retransmissions += 1;
    return packet.sequence;
  }

  advance(nowMs: number) {
    if (nowMs < 0 || !Number.isFinite(nowMs))
      throw new Error("nowMs must be finite and non-negative");
    let deliveredCount = 0;
    while (
      deliveredCount < this.#pending.length &&
      this.#pending[deliveredCount]!.deliveryAtMs <= nowMs
    ) {
      deliveredCount += 1;
    }
    const delivered = this.#pending.splice(0, deliveredCount);
    for (const packet of delivered) {
      this.#metrics.deliveredPackets += 1;
      this.#metrics.deliveredBytes += packet.byteLength;
      this.#metrics.queuedBytes -= packet.byteLength;
    }
    return delivered;
  }

  get metrics(): Readonly<LinkMetrics> {
    return { ...this.#metrics };
  }

  get pendingPackets() {
    return this.#pending.length;
  }
}
