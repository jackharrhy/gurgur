/// <reference lib="webworker" />

import type {
  BodySnapshot,
  InputCommand,
  RuntimeId,
  Snapshot,
  TracePredictionEvent,
} from "@gurgur/engine";
import type { WorldMessage } from "@gurgur/game";
import { PlayerPredictor } from "./prediction";

type WorkerRequest =
  | { type: "local-player"; id: RuntimeId }
  | { type: "world"; message: WorldMessage }
  | { type: "input"; command: InputCommand }
  | { type: "snapshot"; snapshot: Snapshot; reconcilePlayer: boolean }
  | { type: "trace-enabled"; enabled: boolean; requestId: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let predictor: PlayerPredictor;
let worldBarrier = Promise.resolve();
predictor = new PlayerPredictor(
  (body: BodySnapshot | null, bodies: BodySnapshot[]) => {
    scope.postMessage({
      type: "presentation",
      body,
      bodies,
      correctionMagnitude: predictor?.correctionMagnitude ?? 0,
    });
  },
  {
    wasmUrl: "/box3d.wasm",
    onTrace: (event: TracePredictionEvent) => scope.postMessage({ type: "trace", event }),
  },
);

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "local-player") predictor.setLocalPlayer(message.id);
  else if (message.type === "world") {
    worldBarrier = predictor.setWorld(message.message).then(() => {
      scope.postMessage({ type: "world-ready", worldEpoch: message.message.worldEpoch });
    });
  } else if (message.type === "input")
    void worldBarrier.then(() => predictor.pushInput(message.command));
  else if (message.type === "snapshot")
    void worldBarrier.then(() => predictor.reconcile(message.snapshot, message.reconcilePlayer));
  else {
    predictor.setTraceEnabled(message.enabled);
    scope.postMessage({ type: "trace-state", requestId: message.requestId });
  }
});
