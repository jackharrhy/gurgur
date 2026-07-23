import {
  PROTOCOL_VERSION,
  SNAPSHOT_HISTORY_PACKETS,
  decodeSnapshot,
  decodeLifecycle,
  decodeWorldBundle,
  decodeServerControl,
  LIFECYCLE_TAG,
  encodeInput,
  type InputCommand,
  type HelloMessage,
  type LifecycleMessage,
  type Snapshot,
  type WelcomeMessage,
  type WorldMessage,
  type WorldManifestMessage,
} from "@gurgur/shared";

export type SessionCallbacks = {
  status(state: "connecting" | "connected" | "disconnected"): void;
  welcome(message: WelcomeMessage): void;
  world(message: WorldMessage): void;
  lifecycle(message: LifecycleMessage): void;
  snapshot(snapshot: Snapshot, latestInFrame: boolean): void;
  clock?(serverTick: number, receivedAtMs: number, oneWayDelayMs: number): void;
  network?(rttMs: number, jitterMs: number): void;
};

export class GameSession {
  readonly #callbacks: SessionCallbacks;
  readonly #simulatedLatencyMs: number;
  readonly #timers = new Set<number>();
  #socket: WebSocket | null = null;
  #retry: number | null = null;
  #closed = false;
  #worldEpoch: number | null = null;
  #retryAttempt = 0;
  #pingTimer: number | null = null;
  #pingNonce = 0;
  #rttMs = 0;
  #jitterMs = 0;
  #mapRevision: string | null = null;
  #sessionToken: string | null = readSessionToken();
  #socketGeneration = 0;
  #worldLoadGeneration = 0;
  #loadedWorldEpoch: number | null = null;
  #snapshotQueue: Snapshot[] = [];
  #pendingLifecycles: LifecycleMessage[] = [];
  #snapshotFrame: number | null = null;

  constructor(callbacks: SessionCallbacks, options: { simulatedLatencyMs?: number } = {}) {
    this.#callbacks = callbacks;
    this.#simulatedLatencyMs = Math.max(0, Math.min(1_000, options.simulatedLatencyMs ?? 0));
  }

  connect(): void {
    this.#callbacks.status("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/game`);
    const socketGeneration = this.#socketGeneration++;
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("open", () => {
      const hello: HelloMessage = {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        mapRevision: this.#mapRevision,
        worldEpoch: this.#worldEpoch,
        sessionToken: this.#sessionToken,
        socketGeneration,
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event) => {
      this.#defer(() => {
        if (this.#socket !== socket) return;
        this.#handleMessage(socket, event.data);
      });
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket === socket) this.#socket = null;
      if (event.code === 1002 || (event.code === 1008 && event.reason === "unknown session")) {
        this.#sessionToken = null;
        this.#mapRevision = null;
        this.#worldEpoch = null;
        clearSessionToken();
      }
      this.#callbacks.status("disconnected");
      this.#stopPings();
      if (!this.#closed) {
        const base = Math.min(10_000, 500 * 2 ** this.#retryAttempt++);
        const delay = base * (0.8 + Math.random() * 0.4);
        this.#retry = window.setTimeout(() => this.connect(), delay);
      }
    });
  }

  #handleMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      let message;
      try {
        message = decodeServerControl(data);
      } catch {
        socket.close(4002, "invalid server control packet");
        return;
      }
      if (message.type === "welcome") {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          socket.close(4002, "protocol version mismatch");
          return;
        }
        this.#worldEpoch = message.worldEpoch;
        this.#mapRevision = message.mapRevision;
        this.#sessionToken = message.sessionToken;
        writeSessionToken(message.sessionToken);
        this.#retryAttempt = 0;
        this.#callbacks.welcome(message);
        this.#startPings();
      } else if (message.type === "world") {
        if (
          message.protocolVersion !== PROTOCOL_VERSION ||
          message.mapRevision !== this.#mapRevision
        )
          return;
        this.#worldEpoch = message.worldEpoch;
        this.#loadedWorldEpoch = null;
        if (this.#snapshotFrame !== null) cancelAnimationFrame(this.#snapshotFrame);
        this.#snapshotFrame = null;
        this.#snapshotQueue = [];
        this.#pendingLifecycles = [];
        void this.#loadWorld(message, socket);
      } else if (message.type === "pong") {
        if (message.protocolVersion !== PROTOCOL_VERSION || message.worldEpoch !== this.#worldEpoch)
          return;
        const now = performance.now();
        const sample = Math.max(0, now - message.sentAtMs);
        const previous = this.#rttMs || sample;
        this.#rttMs += (sample - this.#rttMs) * 0.125;
        this.#jitterMs += (Math.abs(sample - previous) - this.#jitterMs) * 0.25;
        this.#callbacks.clock?.(message.serverTick, now, sample / 2);
        this.#callbacks.network?.(this.#rttMs, this.#jitterMs);
      }
      return;
    }
    if (new DataView(data).getUint8(0) === LIFECYCLE_TAG) {
      const message = decodeLifecycle(data);
      if (message.worldEpoch === this.#loadedWorldEpoch) this.#callbacks.lifecycle(message);
      else if (message.worldEpoch === this.#worldEpoch) this.#pendingLifecycles.push(message);
    } else {
      const snapshot = decodeSnapshot(data);
      if (snapshot.worldEpoch === this.#loadedWorldEpoch) this.#queueSnapshot(snapshot);
      else if (snapshot.worldEpoch === this.#worldEpoch)
        retainSnapshot(this.#snapshotQueue, snapshot);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#stopPings();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#snapshotFrame !== null) cancelAnimationFrame(this.#snapshotFrame);
    this.#socket?.close(1000, "page closed");
  }

  sendInput(command: InputCommand): void {
    const socket = this.#socket;
    const packet = encodeInput(command);
    this.#defer(() => {
      if (this.#socket === socket && socket?.readyState === WebSocket.OPEN) socket.send(packet);
    });
  }

  #defer(callback: () => void): void {
    if (this.#simulatedLatencyMs === 0) {
      callback();
      return;
    }
    const timer = window.setTimeout(() => {
      this.#timers.delete(timer);
      callback();
    }, this.#simulatedLatencyMs);
    this.#timers.add(timer);
  }

  #startPings(): void {
    this.#stopPings();
    const send = (): void => {
      const socket = this.#socket;
      if (socket?.readyState === WebSocket.OPEN && this.#worldEpoch !== null) {
        socket.send(
          JSON.stringify({
            type: "ping",
            protocolVersion: PROTOCOL_VERSION,
            worldEpoch: this.#worldEpoch,
            nonce: this.#pingNonce++,
            sentAtMs: performance.now(),
          }),
        );
      }
    };
    send();
    this.#pingTimer = window.setInterval(send, 1_000);
  }

  #stopPings(): void {
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  async #loadWorld(message: WorldManifestMessage, socket: WebSocket): Promise<void> {
    const generation = ++this.#worldLoadGeneration;
    try {
      const response = await fetch(message.bundleUrl);
      if (!response.ok) throw new Error(`world bundle request failed with ${response.status}`);
      const bundle = decodeWorldBundle(await response.arrayBuffer());
      if (bundle.mapRevision !== message.mapRevision)
        throw new Error("world bundle revision mismatch");
      if (
        generation !== this.#worldLoadGeneration ||
        this.#socket !== socket ||
        this.#worldEpoch !== message.worldEpoch
      )
        return;
      const world: WorldMessage = { ...message, bundle };
      this.#callbacks.world(world);
      this.#callbacks.status("connected");
      this.#loadedWorldEpoch = message.worldEpoch;
      for (const lifecycle of this.#pendingLifecycles) this.#callbacks.lifecycle(lifecycle);
      this.#pendingLifecycles = [];
      this.#scheduleSnapshotFrame();
    } catch {
      if (generation === this.#worldLoadGeneration) socket.close(4011, "world load failed");
    }
  }

  #queueSnapshot(snapshot: Snapshot): void {
    retainSnapshot(this.#snapshotQueue, snapshot);
    this.#scheduleSnapshotFrame();
  }

  #scheduleSnapshotFrame(): void {
    if (this.#snapshotFrame !== null || this.#snapshotQueue.length === 0) return;
    this.#snapshotFrame = requestAnimationFrame(() => {
      this.#snapshotFrame = null;
      const queued = this.#snapshotQueue;
      this.#snapshotQueue = [];
      for (const [index, state] of queued.entries()) {
        if (state.worldEpoch === this.#loadedWorldEpoch) {
          this.#callbacks.snapshot(state, index === queued.length - 1);
        }
      }
    });
  }
}

export function retainSnapshot(queue: Snapshot[], snapshot: Snapshot): void {
  const latest = queue.at(-1);
  if (latest && snapshot.serverTick <= latest.serverTick) return;
  queue.push(snapshot);
  if (queue.length > SNAPSHOT_HISTORY_PACKETS) queue.shift();
}

function readSessionToken(): string | null {
  try {
    return sessionStorage.getItem("gurgur.session");
  } catch {
    return null;
  }
}

function writeSessionToken(token: string): void {
  try {
    sessionStorage.setItem("gurgur.session", token);
  } catch {
    /* memory-only fallback */
  }
}

function clearSessionToken(): void {
  try {
    sessionStorage.removeItem("gurgur.session");
  } catch {
    /* memory-only fallback */
  }
}
