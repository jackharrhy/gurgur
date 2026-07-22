import type { BodySnapshot, InputCommand, RuntimeId, Snapshot, WorldMessage } from "@gurgur/shared";

type WorkerRequest =
  | { type: "local-player"; id: RuntimeId }
  | { type: "world"; message: WorldMessage }
  | { type: "input"; command: InputCommand }
  | { type: "snapshot"; snapshot: Snapshot };

type WorkerResponse = {
  type: "presentation";
  body: BodySnapshot | null;
  correctionMagnitude: number;
} | { type: "world-ready"; worldEpoch: number };

export class PredictionClient {
  readonly #worker = new Worker("/prediction-worker.js", { type: "module", name: "gurgur-prediction" });
  readonly #worldWaiters = new Map<number, Array<() => void>>();

  constructor(onPresentation: (body: BodySnapshot | null, correctionMagnitude: number) => void) {
    this.#worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === "presentation") {
        onPresentation(event.data.body, event.data.correctionMagnitude);
      } else {
        for (const resolve of this.#worldWaiters.get(event.data.worldEpoch) ?? []) resolve();
        this.#worldWaiters.delete(event.data.worldEpoch);
      }
    });
    this.#worker.addEventListener("error", (event) => {
      console.error("prediction worker failed", event.message);
    });
  }

  setLocalPlayer(id: RuntimeId): void { this.#post({ type: "local-player", id }); }
  setWorld(message: WorldMessage): Promise<void> {
    const promise = new Promise<void>((resolve) => {
      const waiters = this.#worldWaiters.get(message.worldEpoch) ?? [];
      waiters.push(resolve);
      this.#worldWaiters.set(message.worldEpoch, waiters);
    });
    this.#post({ type: "world", message });
    return promise;
  }
  pushInput(command: InputCommand): void { this.#post({ type: "input", command }); }
  reconcile(snapshot: Snapshot): void { this.#post({ type: "snapshot", snapshot }); }
  dispose(): void {
    this.#worker.terminate();
    for (const waiters of this.#worldWaiters.values()) for (const resolve of waiters) resolve();
    this.#worldWaiters.clear();
  }

  #post(message: WorkerRequest): void { this.#worker.postMessage(message); }
}
