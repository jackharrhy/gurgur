import {
  PHYSICS_DT,
  PROXY_INTERPOLATION_MS,
  type BodySnapshot,
  type NetworkObjectState,
  type RuntimeId,
} from "@gurgur/engine";

type TimedState = {
  receivedAtMs: number;
  state: NetworkObjectState;
};

type Track = {
  delayMs: number;
  authorityVersion: number;
  samples: TimedState[];
};

export class PresentationBuffer {
  readonly #tracks = new Map<string, Track>();

  reset(states: readonly NetworkObjectState[], receivedAtMs: number): void {
    this.#tracks.clear();
    this.pushNetwork(states, receivedAtMs);
  }

  pushNetwork(states: readonly NetworkObjectState[], receivedAtMs: number): void {
    this.#push(states, receivedAtMs, PROXY_INTERPOLATION_MS);
  }

  pushLocal(states: readonly NetworkObjectState[], receivedAtMs: number): void {
    this.#push(states, receivedAtMs, PHYSICS_DT * 1_000);
  }

  replaceReliable(state: NetworkObjectState, receivedAtMs: number, local: boolean): void {
    this.#tracks.set(idKey(state.id), {
      delayMs: local ? PHYSICS_DT * 1_000 : PROXY_INTERPOLATION_MS,
      authorityVersion: state.authorityVersion,
      samples: [{ receivedAtMs, state: cloneState(state) }],
    });
  }

  remove(id: RuntimeId): void {
    this.#tracks.delete(idKey(id));
  }

  sample(nowMs: number): BodySnapshot[] {
    return [...this.#tracks.values()].flatMap((track) => {
      const sample = sampleTrack(track, nowMs - track.delayMs);
      return sample ? [toBodySnapshot(sample)] : [];
    });
  }

  #push(states: readonly NetworkObjectState[], receivedAtMs: number, delayMs: number): void {
    for (const state of states) {
      const key = idKey(state.id);
      let track = this.#tracks.get(key);
      if (!track || track.authorityVersion !== state.authorityVersion) {
        track = {
          delayMs,
          authorityVersion: state.authorityVersion,
          samples: [],
        };
        this.#tracks.set(key, track);
      }
      track.delayMs = delayMs;
      const previous = track.samples.at(-1);
      if (previous && previous.state.stateSequence === state.stateSequence) continue;
      track.samples.push({ receivedAtMs, state: cloneState(state) });
      while (track.samples.length > 32) track.samples.shift();
      const cutoff = receivedAtMs - 2_000;
      while (track.samples.length > 2 && track.samples[1]!.receivedAtMs < cutoff)
        track.samples.shift();
    }
  }
}

function sampleTrack(track: Track, targetMs: number): NetworkObjectState | null {
  const samples = track.samples;
  if (samples.length === 0) return null;
  if (samples.length === 1 || targetMs <= samples[0]!.receivedAtMs)
    return cloneState(samples[0]!.state);
  const latest = samples.at(-1)!;
  if (targetMs >= latest.receivedAtMs) return cloneState(latest.state);
  for (let index = 1; index < samples.length; index += 1) {
    const next = samples[index]!;
    if (next.receivedAtMs < targetMs) continue;
    const previous = samples[index - 1]!;
    const span = next.receivedAtMs - previous.receivedAtMs;
    const amount = span <= 0 ? 1 : (targetMs - previous.receivedAtMs) / span;
    return interpolate(previous.state, next.state, amount);
  }
  return cloneState(latest.state);
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

function idKey(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}
