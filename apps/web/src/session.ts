import {
  PROTOCOL_VERSION,
  decodeSnapshot,
  decodeLifecycle,
  decodeServerControl,
  LIFECYCLE_TAG,
  encodeInput,
  type InputCommand,
  type HelloMessage,
  type LifecycleMessage,
  type RtcOfferMessage,
  type Snapshot,
  type SpeechMessage,
  type SpeechRejectedMessage,
  type WelcomeMessage,
  type WorldManifestMessage,
} from "@gurgur/engine";
import { decodeWorldBundle, type WorldMessage } from "@gurgur/game";

export type SessionCallbacks = {
  status(
    state: "connecting" | "connected" | "disconnected",
    close?: { code: number; reason: string },
  ): void;
  welcome(message: WelcomeMessage): void;
  world(message: WorldMessage): void;
  lifecycle(message: LifecycleMessage): void;
  snapshot(snapshot: Snapshot): void;
  clock?(serverTick: number, receivedAtMs: number, oneWayDelayMs: number): void;
  network?(rttMs: number, jitterMs: number): void;
  transport?(state: "negotiating" | "webrtc" | "disconnected"): void;
  speech?(message: SpeechMessage): void;
  speechRejected?(message: SpeechRejectedMessage): void;
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
  #socketGeneration = readSocketGeneration();
  #worldLoadGeneration = 0;
  #loadedWorldEpoch: number | null = null;
  #pendingSnapshot: Snapshot | null = null;
  #pendingLifecycles: LifecycleMessage[] = [];
  #snapshotFrame: number | null = null;
  #peerConnection: RTCPeerConnection | null = null;
  #inputChannel: RTCDataChannel | null = null;
  #stateChannel: RTCDataChannel | null = null;

  constructor(callbacks: SessionCallbacks, options: { simulatedLatencyMs?: number } = {}) {
    this.#callbacks = callbacks;
    this.#simulatedLatencyMs = Math.max(0, Math.min(1_000, options.simulatedLatencyMs ?? 0));
  }

  connect(): void {
    this.#callbacks.status("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/game`);
    const socketGeneration = this.#socketGeneration++;
    writeSocketGeneration(this.#socketGeneration);
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
      this.#callbacks.status("disconnected", { code: event.code, reason: event.reason });
      this.#stopPings();
      this.#closeRtc();
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
        this.#socketGeneration = Math.max(this.#socketGeneration, message.socketGeneration + 1);
        writeSessionToken(message.sessionToken);
        writeSocketGeneration(this.#socketGeneration);
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
        this.#pendingSnapshot = null;
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
      } else if (message.type === "rtc-offer") {
        void this.#acceptRtcOffer(socket, message);
      } else if (message.type === "speech") {
        if (message.worldEpoch === this.#worldEpoch) this.#callbacks.speech?.(message);
      } else if (message.type === "speech-rejected") {
        this.#callbacks.speechRejected?.(message);
      }
      return;
    }
    this.#handleBinary(data);
  }

  #handleBinary(data: ArrayBuffer): void {
    if (new DataView(data).getUint8(0) === LIFECYCLE_TAG) {
      const message = decodeLifecycle(data);
      if (message.worldEpoch === this.#loadedWorldEpoch) this.#callbacks.lifecycle(message);
      else if (message.worldEpoch === this.#worldEpoch) this.#pendingLifecycles.push(message);
    } else {
      const snapshot = decodeSnapshot(data);
      if (snapshot.worldEpoch === this.#loadedWorldEpoch) this.#queueSnapshot(snapshot);
      else if (snapshot.worldEpoch === this.#worldEpoch) this.#retainSnapshot(snapshot);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#stopPings();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#snapshotFrame !== null) cancelAnimationFrame(this.#snapshotFrame);
    this.#closeRtc();
    this.#socket?.close(1000, "page closed");
  }

  speak(requestId: number, text: string): boolean {
    const socket = this.#socket;
    if (
      socket?.readyState !== WebSocket.OPEN ||
      this.#worldEpoch === null ||
      !Number.isSafeInteger(requestId) ||
      requestId < 0
    )
      return false;
    socket.send(
      JSON.stringify({
        type: "speak",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: this.#worldEpoch,
        requestId,
        text,
      }),
    );
    return true;
  }

  sendInput(command: InputCommand): void {
    const socket = this.#socket;
    const packet = encodeInput(command);
    this.#defer(() => {
      if (this.#socket !== socket || socket?.readyState !== WebSocket.OPEN) return;
      const channel = this.#inputChannel;
      if (channel?.readyState === "open" && channel.bufferedAmount < 16_384) channel.send(packet);
    });
  }

  async #acceptRtcOffer(socket: WebSocket, message: RtcOfferMessage): Promise<void> {
    if (this.#socket !== socket || message.worldEpoch !== this.#worldEpoch || this.#peerConnection)
      return;
    this.#closeRtc();
    this.#callbacks.transport?.("negotiating");
    const peer = new RTCPeerConnection({ iceServers: message.iceServers });
    let receivedState = false;
    const input = peer.createDataChannel("gurgur-input-v4", {
      ordered: false,
      maxRetransmits: 0,
    });
    peer.addEventListener("datachannel", (event) => {
      const state = event.channel;
      if (
        this.#peerConnection !== peer ||
        state.label !== "gurgur-state-v4" ||
        this.#stateChannel
      ) {
        state.close();
        return;
      }
      this.#stateChannel = state;
      state.binaryType = "arraybuffer";
      state.addEventListener("message", (stateMessageEvent) => {
        if (this.#peerConnection !== peer || !(stateMessageEvent.data instanceof ArrayBuffer))
          return;
        this.#defer(() => {
          if (this.#peerConnection !== peer) return;
          this.#handleBinary(stateMessageEvent.data as ArrayBuffer);
          if (!receivedState) {
            receivedState = true;
            this.#callbacks.transport?.("webrtc");
          }
        });
      });
    });
    peer.addEventListener("connectionstatechange", () => {
      if (this.#peerConnection === peer && peer.connectionState === "failed")
        socket.close(4012, "state transport failed");
    });
    this.#peerConnection = peer;
    this.#inputChannel = input;
    try {
      await peer.setRemoteDescription(message.description);
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIceGathering(peer);
      if (
        this.#peerConnection !== peer ||
        this.#socket !== socket ||
        socket.readyState !== WebSocket.OPEN
      )
        return;
      const description = peer.localDescription;
      if (!description?.sdp) throw new Error("RTC answer is missing SDP");
      socket.send(
        JSON.stringify({
          type: "rtc-answer",
          protocolVersion: PROTOCOL_VERSION,
          worldEpoch: message.worldEpoch,
          description: { type: "answer", sdp: description.sdp },
        }),
      );
    } catch {
      if (this.#peerConnection === peer) socket.close(4012, "state transport negotiation failed");
    }
  }

  #closeRtc(): void {
    if (this.#peerConnection) this.#callbacks.transport?.("disconnected");
    this.#inputChannel?.close();
    this.#stateChannel?.close();
    this.#peerConnection?.close();
    this.#inputChannel = null;
    this.#stateChannel = null;
    this.#peerConnection = null;
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
    this.#retainSnapshot(snapshot);
    this.#scheduleSnapshotFrame();
  }

  #scheduleSnapshotFrame(): void {
    if (this.#snapshotFrame !== null || !this.#pendingSnapshot) return;
    this.#snapshotFrame = requestAnimationFrame(() => {
      this.#snapshotFrame = null;
      const snapshot = this.#pendingSnapshot;
      this.#pendingSnapshot = null;
      if (snapshot?.worldEpoch === this.#loadedWorldEpoch) this.#callbacks.snapshot(snapshot);
    });
  }

  #retainSnapshot(snapshot: Snapshot): void {
    const current = this.#pendingSnapshot;
    if (
      current &&
      (current.worldEpoch > snapshot.worldEpoch ||
        (current.worldEpoch === snapshot.worldEpoch && current.serverTick > snapshot.serverTick))
    )
      return;
    this.#pendingSnapshot = snapshot;
  }
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(finish, 2_500);
    function finish(): void {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed(): void {
      if (peer.iceGatheringState === "complete") finish();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
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

function readSocketGeneration(): number {
  try {
    const generation = Number(sessionStorage.getItem("gurgur.socket-generation"));
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  } catch {
    return 0;
  }
}

function writeSocketGeneration(generation: number): void {
  try {
    sessionStorage.setItem("gurgur.socket-generation", String(generation));
  } catch {
    /* memory-only fallback */
  }
}
