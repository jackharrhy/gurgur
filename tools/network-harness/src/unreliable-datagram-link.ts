export type NetworkProfile = {
  name: string;
  roundTripLatencyMs: number;
  jitterMs: number;
  lossRate: number;
  maxPacketLifetimeMs: number;
  bandwidthBitsPerSecond: number | null;
};

export type DeliveredDatagram<T> = {
  sequence: number;
  payload: T;
  byteLength: number;
  sentAtMs: number;
  deliveryAtMs: number;
};

export type DatagramMetrics = {
  sentPackets: number;
  deliveredPackets: number;
  droppedPackets: number;
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
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class UnreliableDatagramLink<T> {
  readonly profile: NetworkProfile;
  readonly seed: number;

  #random: () => number;
  #nextSequence = 0;
  #transmitterAvailableAtMs = 0;
  #pending: Array<DeliveredDatagram<T>> = [];
  #outages: Outage[] = [];
  #receiverPausedUntilMs = 0;
  #metrics: DatagramMetrics = {
    sentPackets: 0,
    deliveredPackets: 0,
    droppedPackets: 0,
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
    if (profile.bandwidthBitsPerSecond !== null && profile.bandwidthBitsPerSecond <= 0)
      throw new Error("bandwidth must be positive or null");
    this.profile = { ...profile };
    this.seed = seed >>> 0;
    this.#random = mulberry32(this.seed);
  }

  addOutage(startMs: number, endMs: number): void {
    if (!(startMs >= 0 && endMs > startMs)) throw new Error("invalid outage interval");
    this.#outages.push({ startMs, endMs });
  }

  pauseReceiverUntil(untilMs: number): void {
    if (untilMs < 0) throw new Error("pause deadline must be non-negative");
    this.#receiverPausedUntilMs = Math.max(this.#receiverPausedUntilMs, untilMs);
  }

  send(sentAtMs: number, byteLength: number, payload: T): number {
    if (sentAtMs < 0 || !Number.isFinite(sentAtMs))
      throw new Error("sentAtMs must be finite and non-negative");
    if (!Number.isInteger(byteLength) || byteLength < 0)
      throw new Error("byteLength must be a non-negative integer");
    const sequence = this.#nextSequence++;
    this.#metrics.sentPackets += 1;
    this.#metrics.sentBytes += byteLength;

    const transmissionStart = Math.max(sentAtMs, this.#transmitterAvailableAtMs);
    const serializationMs =
      this.profile.bandwidthBitsPerSecond === null
        ? 0
        : (byteLength * 8 * 1_000) / this.profile.bandwidthBitsPerSecond;
    const transmissionEnd = transmissionStart + serializationMs;
    if (transmissionEnd - sentAtMs > this.profile.maxPacketLifetimeMs) {
      this.#metrics.droppedPackets += 1;
      return sequence;
    }
    this.#transmitterAvailableAtMs = transmissionEnd;
    const jitter =
      this.profile.jitterMs === 0 ? 0 : (this.#random() * 2 - 1) * this.profile.jitterMs;
    const deliveryAtMs = Math.max(
      transmissionEnd,
      transmissionEnd + this.profile.roundTripLatencyMs / 2 + jitter,
    );
    const unavailable =
      this.#random() < this.profile.lossRate ||
      deliveryAtMs - sentAtMs > this.profile.maxPacketLifetimeMs ||
      deliveryAtMs < this.#receiverPausedUntilMs ||
      this.#outages.some(
        (outage) =>
          (sentAtMs >= outage.startMs && sentAtMs < outage.endMs) ||
          (deliveryAtMs >= outage.startMs && deliveryAtMs < outage.endMs),
      );
    if (unavailable) {
      this.#metrics.droppedPackets += 1;
      return sequence;
    }

    this.#pending.push({ sequence, payload, byteLength, sentAtMs, deliveryAtMs });
    this.#metrics.queuedBytes += byteLength;
    this.#metrics.queueHighWaterBytes = Math.max(
      this.#metrics.queueHighWaterBytes,
      this.#metrics.queuedBytes,
    );
    return sequence;
  }

  advance(nowMs: number): DeliveredDatagram<T>[] {
    if (nowMs < 0 || !Number.isFinite(nowMs))
      throw new Error("nowMs must be finite and non-negative");
    const delivered: DeliveredDatagram<T>[] = [];
    const pending: DeliveredDatagram<T>[] = [];
    for (const packet of this.#pending) {
      if (packet.deliveryAtMs <= nowMs) delivered.push(packet);
      else pending.push(packet);
    }
    this.#pending = pending;
    delivered.sort(
      (left, right) => left.deliveryAtMs - right.deliveryAtMs || left.sequence - right.sequence,
    );
    for (const packet of delivered) {
      this.#metrics.deliveredPackets += 1;
      this.#metrics.deliveredBytes += packet.byteLength;
      this.#metrics.queuedBytes -= packet.byteLength;
    }
    return delivered;
  }

  get metrics(): Readonly<DatagramMetrics> {
    return { ...this.#metrics };
  }

  get pendingPackets(): number {
    return this.#pending.length;
  }
}
