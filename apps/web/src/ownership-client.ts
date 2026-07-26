import type {
  InputCommand,
  NetworkObjectState,
  OwnershipChangedPacket,
  OwnershipDeniedMessage,
  OwnershipDropPacket,
  OwnershipRequestMessage,
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
  | { type: "network-states"; states: NetworkObjectState[] }
  | { type: "lifecycle"; message: LifecycleMessage }
  | { type: "ownership-changed"; message: OwnershipChangedPacket }
  | { type: "ownership-denied"; message: OwnershipDeniedMessage };

export type PhysicsWorkerResponse =
  | { type: "world-ready"; worldEpoch: number }
  | { type: "local-states"; states: NetworkObjectState[]; producedAtMs: number }
  | { type: "owner-states"; states: NetworkObjectState[] }
  | { type: "ownership-request"; message: OwnershipRequestMessage }
  | { type: "ownership-drop"; message: OwnershipDropPacket }
  | { type: "owner-commit"; states: NetworkObjectState[] }
  | { type: "error"; message: string };

export type OwnershipClient = {
  setWorld(
    world: WorldMessage,
    states: NetworkObjectState[],
    localPlayerId: RuntimeId,
  ): Promise<void>;
  pushInput(command: InputCommand): void;
  pushNetworkStates(states: NetworkObjectState[]): void;
  applyLifecycle(message: LifecycleMessage): void;
  ownershipChanged(message: OwnershipChangedPacket): void;
  ownershipDenied(message: OwnershipDeniedMessage): void;
  dispose(): void;
};

export function createOwnershipClient(callbacks: {
  localStates(states: NetworkObjectState[], producedAtMs: number): void;
  ownerStates(states: NetworkObjectState[]): void;
  ownershipRequest(message: OwnershipRequestMessage): void;
  ownershipDrop(message: OwnershipDropPacket): void;
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
      callbacks.localStates(message.states, performance.now());
    } else if (message.type === "owner-states") {
      callbacks.ownerStates(message.states);
    } else if (message.type === "ownership-request") {
      callbacks.ownershipRequest(message.message);
    } else if (message.type === "ownership-drop") {
      callbacks.ownershipDrop(message.message);
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
    pushNetworkStates: (states) => post({ type: "network-states", states }),
    applyLifecycle: (message) => post({ type: "lifecycle", message }),
    ownershipChanged: (message) => post({ type: "ownership-changed", message }),
    ownershipDenied: (message) => post({ type: "ownership-denied", message }),
    dispose() {
      worker.terminate();
      for (const waiters of ready.values()) for (const resolve of waiters) resolve();
      ready.clear();
    },
  };
}
