import type {
  InputCommand,
  ManipulationChangedMessage,
  ManipulationDeniedMessage,
  ManipulationDropMessage,
  ManipulationRequestMessage,
  ManipulationStatePacket,
  NetworkObjectState,
  OwnershipChangedPacket,
  LifecycleMessage,
  RuntimeId,
} from "@gurgur/engine";
import type { WorldMessage } from "@gurgur/game";

export type PhysicsWorkerRequest =
  | {
      type: "world";
      world: WorldMessage;
      states: NetworkObjectState[];
      localPlayerId: RuntimeId;
    }
  | { type: "input"; command: InputCommand }
  | { type: "network-states"; states: NetworkObjectState[]; receivedAtMs: number }
  | {
      type: "clock";
      serverTick: number;
      receivedAtMs: number;
      oneWayDelayMs: number;
    }
  | { type: "lifecycle"; message: LifecycleMessage }
  | { type: "ownership-changed"; message: OwnershipChangedPacket }
  | { type: "manipulation-changed"; message: ManipulationChangedMessage }
  | { type: "manipulation-denied"; message: ManipulationDeniedMessage }
  | { type: "stall-for-test"; durationMs: number };

export type PhysicsWorkerResponse =
  | { type: "world-ready"; worldEpoch: number }
  | {
      type: "local-states";
      states: NetworkObjectState[];
      producedAtMs: number;
      discardedCatchUpSeconds: number;
    }
  | { type: "owner-states"; states: NetworkObjectState[] }
  | { type: "manipulation-request"; message: ManipulationRequestMessage }
  | { type: "manipulation-state"; message: ManipulationStatePacket }
  | { type: "manipulation-drop"; message: ManipulationDropMessage }
  | { type: "owner-commit"; states: NetworkObjectState[] }
  | { type: "error"; message: string };

export type OwnershipClient = {
  setWorld(
    world: WorldMessage,
    states: NetworkObjectState[],
    localPlayerId: RuntimeId,
  ): Promise<void>;
  pushInput(command: InputCommand): void;
  pushNetworkStates(states: NetworkObjectState[], receivedAtMs: number): void;
  updateClock(serverTick: number, receivedAtMs: number, oneWayDelayMs: number): void;
  applyLifecycle(message: LifecycleMessage): void;
  ownershipChanged(message: OwnershipChangedPacket): void;
  manipulationChanged(message: ManipulationChangedMessage): void;
  manipulationDenied(message: ManipulationDeniedMessage): void;
  stallForTest(durationMs: number): void;
  dispose(): void;
};

export function createOwnershipClient(callbacks: {
  localStates(
    states: NetworkObjectState[],
    producedAtMs: number,
    discardedCatchUpSeconds: number,
  ): void;
  ownerStates(states: NetworkObjectState[]): void;
  manipulationRequest(message: ManipulationRequestMessage): void;
  manipulationState(message: ManipulationStatePacket): void;
  manipulationDrop(message: ManipulationDropMessage): void;
  ownerCommit(states: NetworkObjectState[]): void;
  error(message: string): void;
}): OwnershipClient {
  const worker = new Worker("/physics-worker.js", {
    type: "module",
    name: "gurgur-owner-physics",
  });
  const ready = new Map<number, Array<() => void>>();

  worker.addEventListener("message", (event: MessageEvent<PhysicsWorkerResponse>) => {
    const message = event.data;
    if (message.type === "world-ready") {
      for (const resolve of ready.get(message.worldEpoch) ?? []) resolve();
      ready.delete(message.worldEpoch);
    } else if (message.type === "local-states") {
      callbacks.localStates(message.states, performance.now(), message.discardedCatchUpSeconds);
    } else if (message.type === "owner-states") {
      callbacks.ownerStates(message.states);
    } else if (message.type === "manipulation-request") {
      callbacks.manipulationRequest(message.message);
    } else if (message.type === "manipulation-state") {
      callbacks.manipulationState(message.message);
    } else if (message.type === "manipulation-drop") {
      callbacks.manipulationDrop(message.message);
    } else if (message.type === "owner-commit") {
      callbacks.ownerCommit(message.states);
    } else {
      callbacks.error(message.message);
    }
  });
  worker.addEventListener("error", (event) => callbacks.error(event.message));

  const post = (message: PhysicsWorkerRequest): void => worker.postMessage(message);
  return {
    setWorld(world, states, localPlayerId) {
      const promise = new Promise<void>((resolve) => {
        const waiters = ready.get(world.worldEpoch) ?? [];
        waiters.push(resolve);
        ready.set(world.worldEpoch, waiters);
      });
      post({ type: "world", world, states, localPlayerId });
      return promise;
    },
    pushInput: (command) => post({ type: "input", command }),
    pushNetworkStates: (states, receivedAtMs) =>
      post({ type: "network-states", states, receivedAtMs }),
    updateClock: (serverTick, receivedAtMs, oneWayDelayMs) =>
      post({ type: "clock", serverTick, receivedAtMs, oneWayDelayMs }),
    applyLifecycle: (message) => post({ type: "lifecycle", message }),
    ownershipChanged: (message) => post({ type: "ownership-changed", message }),
    manipulationChanged: (message) => post({ type: "manipulation-changed", message }),
    manipulationDenied: (message) => post({ type: "manipulation-denied", message }),
    stallForTest: (durationMs) => post({ type: "stall-for-test", durationMs }),
    dispose() {
      worker.terminate();
      for (const waiters of ready.values()) for (const resolve of waiters) resolve();
      ready.clear();
    },
  };
}
