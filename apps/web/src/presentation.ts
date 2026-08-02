import {
  PHYSICS_HZ,
  NETWORK_FLAG_AWAKE,
  NETWORK_FLAG_HELD,
  PROXY_INTERPOLATION_TICKS,
  RENDER_INTERPOLATION_MAX_TICKS,
  RENDER_INTERPOLATION_MIN_TICKS,
  unwrapTick32,
  type BodySnapshot,
  type NetworkObjectState,
  type RuntimeId,
} from "@gurgur/engine";

type TimedState = {
  receivedAtMs: number;
  timelineTick: number;
  state: NetworkObjectState;
};

type Track = {
  delayTicks: number;
  desiredDelayTicks: number;
  underrunRequiredTicks: number;
  underrunHoldUntilMs: number;
  lastAdaptiveSampleMs: number | null;
  underrunSamples: number;
  latenessSamples: LatenessSample[];
  timeline: "host" | "local";
  authorityVersion: number;
  samples: TimedState[];
};

type ClockAnchor = {
  serverTick: number;
  localAtServerTickMs: number;
};

export type PresentationBufferOptions = {
  networkDelayPolicy?: "fixed-proxy" | "adaptive-render";
};

export type PresentationBufferDiagnostics = {
  networkDelayPolicy: "fixed-proxy" | "adaptive-render";
  minimumNetworkDelayTicks: number;
  networkDelayTicks: number;
  desiredNetworkDelayTicks: number;
  underrunSamples: number;
  trackDelayTicks: Record<string, number>;
};

type LatenessSample = { receivedAtMs: number; ticks: number };

const LATENESS_WINDOW_MS = 10_000;
const UNDERRUN_HOLD_MS = 500;
const DELAY_BUILD_RATE_TICKS_PER_TICK = 0.9;
const DELAY_RELEASE_RATE_TICKS_PER_SECOND = 2;

export class PresentationBuffer {
  readonly #tracks = new Map<string, Track>();
  readonly #latestNetwork = new Map<string, NetworkObjectState>();
  readonly #networkDelayPolicy: "fixed-proxy" | "adaptive-render";
  #clock: ClockAnchor | null = null;

  constructor(options: PresentationBufferOptions = {}) {
    this.#networkDelayPolicy = options.networkDelayPolicy ?? "fixed-proxy";
  }

  reset(states: readonly NetworkObjectState[], receivedAtMs: number): void {
    this.#tracks.clear();
    this.#latestNetwork.clear();
    this.#clock = null;
    this.pushNetwork(states, receivedAtMs);
  }

  updateClock(serverTick: number, receivedAtMs: number, oneWayDelayMs: number): void {
    if (
      !Number.isSafeInteger(serverTick) ||
      serverTick < 0 ||
      !Number.isFinite(receivedAtMs) ||
      !Number.isFinite(oneWayDelayMs)
    )
      return;
    this.#clock = {
      serverTick,
      localAtServerTickMs: receivedAtMs - Math.max(0, oneWayDelayMs),
    };
  }

  pushNetwork(
    states: readonly NetworkObjectState[],
    receivedAtMs: number,
    preserveLocalIds: ReadonlySet<string> = new Set(),
  ): void {
    for (const state of states) this.#latestNetwork.set(idKey(state.id), cloneState(state));
    const hostStates = states.filter((state) => !preserveLocalIds.has(idKey(state.id)));
    this.#push(hostStates, receivedAtMs, "host", PROXY_INTERPOLATION_TICKS);
    this.#observeNetworkLateness(hostStates, receivedAtMs);
  }

  pushLocal(states: readonly NetworkObjectState[], receivedAtMs: number): void {
    this.#push(states, receivedAtMs, "local", 0);
  }

  replaceReliable(state: NetworkObjectState, receivedAtMs: number, local: boolean): void {
    const delayTicks =
      !local && this.#networkDelayPolicy === "adaptive-render"
        ? RENDER_INTERPOLATION_MIN_TICKS
        : local
          ? 0
          : PROXY_INTERPOLATION_TICKS;
    this.#tracks.set(idKey(state.id), {
      delayTicks,
      desiredDelayTicks: delayTicks,
      underrunRequiredTicks: RENDER_INTERPOLATION_MIN_TICKS,
      underrunHoldUntilMs: 0,
      lastAdaptiveSampleMs: receivedAtMs,
      underrunSamples: 0,
      latenessSamples: [],
      timeline: local ? "local" : "host",
      authorityVersion: state.authorityVersion,
      samples: [
        {
          receivedAtMs,
          timelineTick: state.sourceTick,
          state: cloneState(state),
        },
      ],
    });
    if (!local) this.#latestNetwork.set(idKey(state.id), cloneState(state));
  }

  remove(id: RuntimeId): void {
    this.#tracks.delete(idKey(id));
    this.#latestNetwork.delete(idKey(id));
  }

  sample(nowMs: number): BodySnapshot[] {
    return [...this.#tracks.values()].flatMap((track) => {
      const latest = track.samples.at(-1);
      if (!latest) return [];
      this.#adaptNetworkDelay(track, nowMs);
      const clockTick =
        track.timeline === "host" && this.#clock
          ? alignClockTick(
              this.#clock.serverTick +
                ((nowMs - this.#clock.localAtServerTickMs) / 1_000) * PHYSICS_HZ,
              latest.timelineTick,
            )
          : latest.timelineTick + (Math.max(0, nowMs - latest.receivedAtMs) / 1_000) * PHYSICS_HZ;
      const sample = sampleTrack(track, clockTick - track.delayTicks);
      return sample ? [toBodySnapshot(sample)] : [];
    });
  }

  diagnostics(): PresentationBufferDiagnostics {
    const delays = [...this.#tracks.values()]
      .filter((track) => track.timeline === "host")
      .map((track) => track.delayTicks);
    const desired = [...this.#tracks.values()]
      .filter((track) => track.timeline === "host")
      .map((track) => track.desiredDelayTicks);
    const fallback =
      this.#networkDelayPolicy === "adaptive-render"
        ? RENDER_INTERPOLATION_MIN_TICKS
        : PROXY_INTERPOLATION_TICKS;
    return {
      networkDelayPolicy: this.#networkDelayPolicy,
      minimumNetworkDelayTicks: delays.length > 0 ? Math.min(...delays) : fallback,
      networkDelayTicks: delays.length > 0 ? Math.max(...delays) : fallback,
      desiredNetworkDelayTicks: desired.length > 0 ? Math.max(...desired) : fallback,
      underrunSamples: [...this.#tracks.values()].reduce(
        (sum, track) => sum + track.underrunSamples,
        0,
      ),
      trackDelayTicks: Object.fromEntries(
        [...this.#tracks.entries()].map(([key, track]) => [key, track.delayTicks]),
      ),
    };
  }

  trackDelayTicks(id: RuntimeId): number | null {
    return this.#tracks.get(idKey(id))?.delayTicks ?? null;
  }

  latestNetwork(id: RuntimeId): BodySnapshot | null {
    const latest = this.#latestNetwork.get(idKey(id));
    return latest ? toBodySnapshot(latest) : null;
  }

  #push(
    states: readonly NetworkObjectState[],
    receivedAtMs: number,
    timeline: Track["timeline"],
    delayTicks: number,
  ): void {
    for (const state of states) {
      const key = idKey(state.id);
      let track = this.#tracks.get(key);
      if (
        !track ||
        track.authorityVersion !== state.authorityVersion ||
        track.timeline !== timeline
      ) {
        const initialDelay =
          timeline === "host" && this.#networkDelayPolicy === "adaptive-render"
            ? RENDER_INTERPOLATION_MIN_TICKS
            : delayTicks;
        track = {
          delayTicks: initialDelay,
          desiredDelayTicks: initialDelay,
          underrunRequiredTicks: RENDER_INTERPOLATION_MIN_TICKS,
          underrunHoldUntilMs: 0,
          lastAdaptiveSampleMs: receivedAtMs,
          underrunSamples: 0,
          latenessSamples: [],
          timeline,
          authorityVersion: state.authorityVersion,
          samples: [],
        };
        this.#tracks.set(key, track);
      }
      if (timeline === "local" || this.#networkDelayPolicy === "fixed-proxy") {
        track.delayTicks = delayTicks;
        track.desiredDelayTicks = delayTicks;
      }
      const previous = track.samples.at(-1);
      if (previous?.state.stateSequence === state.stateSequence) continue;
      const timelineTick = previous
        ? unwrapTick32(state.sourceTick, previous.timelineTick)
        : state.sourceTick;
      if (previous && timelineTick < previous.timelineTick) continue;
      const sample = {
        receivedAtMs,
        timelineTick,
        state: cloneState(state),
      };
      if (previous && timelineTick === previous.timelineTick)
        track.samples[track.samples.length - 1] = sample;
      else track.samples.push(sample);
      while (track.samples.length > 64) track.samples.shift();
      const cutoff = timelineTick - PHYSICS_HZ * 2;
      while (track.samples.length > 2 && track.samples[1]!.timelineTick < cutoff)
        track.samples.shift();
    }
  }

  #observeNetworkLateness(states: readonly NetworkObjectState[], receivedAtMs: number): void {
    if (this.#networkDelayPolicy !== "adaptive-render" || !this.#clock) return;
    for (const state of states) {
      const track = this.#tracks.get(idKey(state.id));
      const latest = track?.samples.at(-1);
      if (!track || track.timeline !== "host" || latest?.receivedAtMs !== receivedAtMs) continue;
      if (!activeNetworkState(state)) continue;
      track.latenessSamples.push({
        receivedAtMs,
        ticks: Math.max(0, this.#clockTick(track, receivedAtMs) - latest.timelineTick),
      });
      this.#pruneLateness(track, receivedAtMs);
      const measured = this.#measuredDelayTicks(track);
      track.desiredDelayTicks =
        receivedAtMs < track.underrunHoldUntilMs
          ? Math.max(measured, track.underrunRequiredTicks)
          : measured;
    }
  }

  #adaptNetworkDelay(track: Track, nowMs: number): void {
    if (
      this.#networkDelayPolicy !== "adaptive-render" ||
      track.timeline !== "host" ||
      !Number.isFinite(nowMs)
    )
      return;
    const previousAt = track.lastAdaptiveSampleMs ?? nowMs;
    const elapsedSeconds = Math.max(0, (nowMs - previousAt) / 1_000);
    track.lastAdaptiveSampleMs = nowMs;
    this.#pruneLateness(track, nowMs);

    const latest = track.samples.at(-1);
    const required = latest
      ? Math.ceil(Math.max(0, this.#clockTick(track, nowMs) - latest.timelineTick + 1))
      : RENDER_INTERPOLATION_MIN_TICKS;
    const underrun =
      latest !== undefined &&
      track.samples.length >= 2 &&
      latest.timelineTick - track.samples[0]!.timelineTick >= RENDER_INTERPOLATION_MIN_TICKS &&
      nowMs - latest.receivedAtMs <= 250 &&
      activeNetworkState(latest.state) &&
      track.delayTicks + 1e-6 < required;
    if (underrun) {
      track.underrunSamples += 1;
      track.underrunRequiredTicks = clamp(
        required,
        RENDER_INTERPOLATION_MIN_TICKS,
        RENDER_INTERPOLATION_MAX_TICKS,
      );
      track.underrunHoldUntilMs = nowMs + UNDERRUN_HOLD_MS;
      track.desiredDelayTicks = Math.max(track.desiredDelayTicks, track.underrunRequiredTicks);
    } else if (nowMs >= track.underrunHoldUntilMs) {
      track.desiredDelayTicks = this.#measuredDelayTicks(track);
    }

    if (track.desiredDelayTicks > track.delayTicks) {
      track.delayTicks = Math.min(
        track.desiredDelayTicks,
        track.delayTicks + elapsedSeconds * PHYSICS_HZ * DELAY_BUILD_RATE_TICKS_PER_TICK,
      );
    } else {
      track.delayTicks = Math.max(
        track.desiredDelayTicks,
        track.delayTicks - elapsedSeconds * DELAY_RELEASE_RATE_TICKS_PER_SECOND,
      );
    }
  }

  #measuredDelayTicks(track: Track): number {
    const sorted = track.latenessSamples.map((sample) => sample.ticks).toSorted((a, b) => a - b);
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    return clamp(
      Math.ceil(p95 + 1),
      RENDER_INTERPOLATION_MIN_TICKS,
      RENDER_INTERPOLATION_MAX_TICKS,
    );
  }

  #clockTick(track: Track, nowMs: number): number {
    const latest = track.samples.at(-1)!;
    return this.#clock
      ? alignClockTick(
          this.#clock.serverTick + ((nowMs - this.#clock.localAtServerTickMs) / 1_000) * PHYSICS_HZ,
          latest.timelineTick,
        )
      : latest.timelineTick + (Math.max(0, nowMs - latest.receivedAtMs) / 1_000) * PHYSICS_HZ;
  }

  #pruneLateness(track: Track, nowMs: number): void {
    const cutoff = nowMs - LATENESS_WINDOW_MS;
    while (track.latenessSamples.length > 0 && track.latenessSamples[0]!.receivedAtMs < cutoff)
      track.latenessSamples.shift();
  }
}

function activeNetworkState(state: NetworkObjectState): boolean {
  return (
    (state.flags & (NETWORK_FLAG_AWAKE | NETWORK_FLAG_HELD)) !== 0 ||
    Math.hypot(
      state.linearVelocity.x,
      state.linearVelocity.y,
      state.linearVelocity.z,
      state.angularVelocity.x,
      state.angularVelocity.y,
      state.angularVelocity.z,
    ) > 1e-4
  );
}

function sampleTrack(track: Track, targetTick: number): NetworkObjectState | null {
  const samples = track.samples;
  if (samples.length === 0) return null;
  if (samples.length === 1 || targetTick <= samples[0]!.timelineTick)
    return cloneState(samples[0]!.state);
  const latest = samples.at(-1)!;
  if (targetTick >= latest.timelineTick) return cloneState(latest.state);
  for (let index = 1; index < samples.length; index += 1) {
    const next = samples[index]!;
    if (next.timelineTick < targetTick) continue;
    const previous = samples[index - 1]!;
    const span = next.timelineTick - previous.timelineTick;
    const amount = span <= 0 ? 1 : (targetTick - previous.timelineTick) / span;
    return interpolate(previous.state, next.state, amount);
  }
  return cloneState(latest.state);
}

function alignClockTick(clockTick: number, reference: number): number {
  const whole = Math.floor(clockTick);
  return unwrapTick32(whole >>> 0, reference) + (clockTick - whole);
}

function interpolate(
  previous: NetworkObjectState,
  next: NetworkObjectState,
  amount: number,
): NetworkObjectState {
  const common = {
    ...next,
    id: { ...next.id },
    position: mixVec3(previous.position, next.position, amount),
    rotation: mixQuat(previous.rotation, next.rotation, amount),
    linearVelocity: mixVec3(previous.linearVelocity, next.linearVelocity, amount),
    angularVelocity: mixVec3(previous.angularVelocity, next.angularVelocity, amount),
  };
  if (next.kind === "player" && previous.kind === "player") {
    return {
      ...common,
      kind: "player",
      yaw: mixAngle(previous.yaw, next.yaw, amount),
      verticalVelocity: mix(previous.verticalVelocity, next.verticalVelocity, amount),
      grounded: next.grounded,
      crouched: next.crouched,
      lastJumpCounter: next.lastJumpCounter,
      stepCooldown: mix(previous.stepCooldown, next.stepCooldown, amount),
    };
  }
  return { ...common, kind: "body" };
}

function toBodySnapshot(state: NetworkObjectState): BodySnapshot {
  return {
    id: { ...state.id },
    position: { ...state.position },
    rotation: { ...state.rotation },
    linearVelocity: { ...state.linearVelocity },
    angularVelocity: { ...state.angularVelocity },
    flags: state.flags,
  };
}

function cloneState(state: NetworkObjectState): NetworkObjectState {
  if (state.kind === "player") {
    return {
      ...state,
      kind: "player",
      id: { ...state.id },
      position: { ...state.position },
      rotation: { ...state.rotation },
      linearVelocity: { ...state.linearVelocity },
      angularVelocity: { ...state.angularVelocity },
    };
  }
  return {
    ...state,
    kind: "body",
    id: { ...state.id },
    position: { ...state.position },
    rotation: { ...state.rotation },
    linearVelocity: { ...state.linearVelocity },
    angularVelocity: { ...state.angularVelocity },
  };
}

function mixVec3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  amount: number,
) {
  return {
    x: mix(a.x, b.x, amount),
    y: mix(a.y, b.y, amount),
    z: mix(a.z, b.z, amount),
  };
}

function mixQuat(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
  amount: number,
) {
  const sign = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const value = {
    x: mix(a.x, b.x * sign, amount),
    y: mix(a.y, b.y * sign, amount),
    z: mix(a.z, b.z * sign, amount),
    w: mix(a.w, b.w * sign, amount),
  };
  const length = Math.hypot(value.x, value.y, value.z, value.w) || 1;
  return {
    x: value.x / length,
    y: value.y / length,
    z: value.z / length,
    w: value.w / length,
  };
}

function mixAngle(a: number, b: number, amount: number): number {
  const difference = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + difference * amount;
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function idKey(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}
