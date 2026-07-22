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

export type PredictionClient = {
  setLocalPlayer(id: RuntimeId): void;
  setWorld(message: WorldMessage): Promise<void>;
  pushInput(command: InputCommand): void;
  reconcile(snapshot: Snapshot): void;
  dispose(): void;
};

export function createPredictionClient(
  onPresentation: (body: BodySnapshot | null, correctionMagnitude: number) => void,
): PredictionClient {
  const worker = new Worker("/prediction-worker.js", { type: "module", name: "gurgur-prediction" });
  const worldWaiters = new Map<number, Array<() => void>>();

  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    if (event.data.type === "presentation") {
      onPresentation(event.data.body, event.data.correctionMagnitude);
    } else {
      for (const resolve of worldWaiters.get(event.data.worldEpoch) ?? []) resolve();
      worldWaiters.delete(event.data.worldEpoch);
    }
  });
  worker.addEventListener("error", (event) => console.error("prediction worker failed", event.message));

  const post = (message: WorkerRequest): void => worker.postMessage(message);
  const setWorld = (message: WorldMessage): Promise<void> => {
    const promise = new Promise<void>((resolve) => {
      const waiters = worldWaiters.get(message.worldEpoch) ?? [];
      waiters.push(resolve);
      worldWaiters.set(message.worldEpoch, waiters);
    });
    post({ type: "world", message });
    return promise;
  };
  const dispose = (): void => {
    worker.terminate();
    for (const waiters of worldWaiters.values()) for (const resolve of waiters) resolve();
    worldWaiters.clear();
  };

  return {
    setLocalPlayer: (id) => post({ type: "local-player", id }),
    setWorld,
    pushInput: (command) => post({ type: "input", command }),
    reconcile: (snapshot) => post({ type: "snapshot", snapshot }),
    dispose,
  };
}
