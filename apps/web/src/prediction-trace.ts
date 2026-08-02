import type { Quat, RuntimeId, Vec3 } from "@gurgur/engine";

export type PredictionTracePose = { position: Vec3; rotation: Quat };
export type PredictionTraceTimelines = {
  authoritative: PredictionTracePose | null;
  collision: PredictionTracePose | null;
  predicted: PredictionTracePose | null;
  rendered: PredictionTracePose | null;
};

export type PredictionTraceFrame = {
  atMs: number;
  inputSequence: number;
  serverTick: number;
  acknowledgment: number | null;
  replayCount: number;
  contactIds: RuntimeId[];
  supportIds: RuntimeId[];
  player: PredictionTraceTimelines;
  held: PredictionTraceTimelines | null;
};

export class PredictionTraceRecorder {
  readonly #capacity: number;
  readonly #frames: PredictionTraceFrame[] = [];

  constructor(capacity = 600) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("prediction trace capacity must be positive");
    this.#capacity = capacity;
  }

  record(frame: PredictionTraceFrame): void {
    this.#frames.push(structuredClone(frame));
    while (this.#frames.length > this.#capacity) this.#frames.shift();
  }

  frames(): PredictionTraceFrame[] {
    return structuredClone(this.#frames);
  }

  reset(): void {
    this.#frames.length = 0;
  }
}
