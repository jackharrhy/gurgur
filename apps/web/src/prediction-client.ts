import type {
  BodySnapshot,
  InputCommand,
  RuntimeId,
  Snapshot,
  TracePredictionEvent,
} from "@gurgur/engine";
import type { WorldMessage } from "@gurgur/game";

type WorkerRequest =
  | { type: "local-player"; id: RuntimeId }
  | { type: "world"; message: WorldMessage }
  | { type: "input"; command: InputCommand }
  | { type: "snapshot"; snapshot: Snapshot; reconcilePlayer: boolean }
  | { type: "trace-enabled"; enabled: boolean; requestId: number };

type WorkerResponse =
  | {
      type: "presentation";
      body: BodySnapshot | null;
      bodies: BodySnapshot[];
      correctionMagnitude: number;
    }
  | { type: "trace"; event: TracePredictionEvent }
  | { type: "trace-state"; requestId: number }
  | { type: "world-ready"; worldEpoch: number };

export type PredictionClient = {
  setLocalPlayer(id: RuntimeId): void;
  setWorld(message: WorldMessage): Promise<void>;
  pushInput(command: InputCommand): void;
  reconcile(snapshot: Snapshot, reconcilePlayer?: boolean): void;
  setTraceEnabled(enabled: boolean): Promise<void>;
  dispose(): void;
};

export function createPredictionClient(
  onPresentation: (
    body: BodySnapshot | null,
    bodies: BodySnapshot[],
    correctionMagnitude: number,
  ) => void,
  onTrace: (event: TracePredictionEvent) => void = () => {},
): PredictionClient {
  const worker = new Worker("/prediction-worker.js", { type: "module", name: "gurgur-prediction" });
  const worldWaiters = new Map<number, Array<() => void>>();
  const traceWaiters = new Map<number, () => void>();
  let nextTraceRequestId = 0;

  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    if (event.data.type === "presentation") {
      onPresentation(event.data.body, event.data.bodies, event.data.correctionMagnitude);
    } else if (event.data.type === "trace") {
      onTrace(event.data.event);
    } else if (event.data.type === "trace-state") {
      traceWaiters.get(event.data.requestId)?.();
      traceWaiters.delete(event.data.requestId);
    } else {
      for (const resolve of worldWaiters.get(event.data.worldEpoch) ?? []) resolve();
      worldWaiters.delete(event.data.worldEpoch);
    }
  });
  worker.addEventListener("error", (event) =>
    console.error("prediction worker failed", event.message),
  );

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
    for (const resolve of traceWaiters.values()) resolve();
    traceWaiters.clear();
  };

  return {
    setLocalPlayer: (id) => post({ type: "local-player", id }),
    setWorld,
    pushInput: (command) => post({ type: "input", command }),
    reconcile: (snapshot, reconcilePlayer = true) =>
      post({ type: "snapshot", snapshot, reconcilePlayer }),
    setTraceEnabled: (enabled) => {
      const requestId = nextTraceRequestId++;
      const ready = new Promise<void>((resolve) => traceWaiters.set(requestId, resolve));
      post({ type: "trace-enabled", enabled, requestId });
      return ready;
    },
    dispose,
  };
}
