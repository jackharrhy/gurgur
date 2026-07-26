import {
  BOOTSTRAP_STATE_TAG,
  LIFECYCLE_TAG,
  OWNERSHIP_CHANGED_TAG,
  PROTOCOL_VERSION,
  STATE_CLUSTER_TAG,
  StateReceiver,
  binaryPacketTag,
  decodeBootstrapState,
  decodeLifecycle,
  decodeOwnershipChanged,
  decodeServerControl,
  decodeStateCluster,
  encodeOwnedState,
  encodeOwnershipDrop,
  encodeOwnerCommit,
  encodeStateAck,
  type BootstrapStatePacket,
  type HelloMessage,
  type LifecycleMessage,
  type NetworkObjectState,
  type OwnershipChangedPacket,
  type OwnershipDeniedMessage,
  type OwnershipDropPacket,
  type OwnershipRequestMessage,
  type RtcOfferMessage,
  type SpeechMessage,
  type SpeechRejectedMessage,
  type StateClusterPacket,
  type UseRequestMessage,
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
  bootstrap(states: NetworkObjectState[], receivedAtMs: number): void;
  lifecycle(message: LifecycleMessage): void;
  state(states: NetworkObjectState[], receivedAtMs: number): void;
  ownership(message: OwnershipChangedPacket, receivedAtMs: number): void;
  ownershipDenied(message: OwnershipDeniedMessage): void;
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
  readonly #receiver = new StateReceiver();
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
  #pendingBootstrap: BootstrapStatePacket | null = null;
  #pendingLifecycles: LifecycleMessage[] = [];
  #pendingClusters: StateClusterPacket[] = [];
  #pendingOwnership: OwnershipChangedPacket[] = [];
  #peerConnection: RTCPeerConnection | null = null;
  #ownerChannel: RTCDataChannel | null = null;
  #stateChannel: RTCDataChannel | null = null;
  #transportReady = false;

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
        if (this.#socket === socket) this.#handleMessage(socket, event.data);
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

  close(): void {
    this.#closed = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#stopPings();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#closeRtc();
    this.#socket?.close(1000, "page closed");
  }

  sendOwnerStates(states: NetworkObjectState[]): void {
    const channel = this.#ownerChannel;
    const packet = encodeOwnedState({ worldEpoch: this.#worldEpoch ?? 0, states });
    this.#defer(() => {
      if (
        channel?.readyState === "open" &&
        channel === this.#ownerChannel &&
        channel.bufferedAmount < 16_384
      ) {
        channel.send(packet);
      }
    });
  }

  requestOwnership(message: OwnershipRequestMessage): boolean {
    return this.#sendControl(message);
  }

  dropOwnership(message: OwnershipDropPacket): boolean {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN || message.worldEpoch !== this.#worldEpoch)
      return false;
    socket.send(encodeOwnershipDrop(message));
    return true;
  }

  commitOwnerStates(states: NetworkObjectState[]): boolean {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN || this.#worldEpoch === null) return false;
    socket.send(encodeOwnerCommit({ worldEpoch: this.#worldEpoch, states }));
    return true;
  }

  use(message: UseRequestMessage): boolean {
    return this.#sendControl(message);
  }

  speak(requestId: number, text: string): boolean {
    if (this.#worldEpoch === null) return false;
    return this.#sendControl({
      type: "speak",
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: this.#worldEpoch,
      requestId,
      text,
    });
  }

  #sendControl(message: object): boolean {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  #handleMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      this.#handleBinary(socket, data);
      return;
    }
    let message;
    try {
      message = decodeServerControl(data);
    } catch {
      socket.close(4002, "invalid server control packet");
      return;
    }
    if (message.type === "welcome") {
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
      if (message.mapRevision !== this.#mapRevision) return;
      this.#worldEpoch = message.worldEpoch;
      this.#loadedWorldEpoch = null;
      this.#pendingBootstrap = null;
      this.#pendingLifecycles = [];
      this.#pendingClusters = [];
      this.#pendingOwnership = [];
      void this.#loadWorld(message, socket);
    } else if (message.type === "pong") {
      if (message.worldEpoch !== this.#worldEpoch) return;
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
    } else if (message.type === "ownership-denied") {
      if (message.worldEpoch === this.#worldEpoch) this.#callbacks.ownershipDenied(message);
    }
  }

  #handleBinary(socket: WebSocket, data: ArrayBuffer): void {
    try {
      const tag = binaryPacketTag(data);
      if (tag === LIFECYCLE_TAG) {
        const message = decodeLifecycle(data);
        if (message.worldEpoch === this.#loadedWorldEpoch) this.#callbacks.lifecycle(message);
        else if (message.worldEpoch === this.#worldEpoch) this.#pendingLifecycles.push(message);
      } else if (tag === BOOTSTRAP_STATE_TAG) {
        const bootstrap = decodeBootstrapState(data);
        if (bootstrap.worldEpoch !== this.#worldEpoch) return;
        this.#receiver.reset(bootstrap.states);
        if (bootstrap.worldEpoch === this.#loadedWorldEpoch)
          this.#callbacks.bootstrap(bootstrap.states, performance.now());
        else this.#pendingBootstrap = bootstrap;
      } else if (tag === OWNERSHIP_CHANGED_TAG) {
        const ownership = decodeOwnershipChanged(data);
        if (ownership.worldEpoch !== this.#worldEpoch) return;
        if (!this.#receiver.replaceReliable(ownership.state)) return;
        if (ownership.worldEpoch === this.#loadedWorldEpoch)
          this.#callbacks.ownership(ownership, performance.now());
        else this.#pendingOwnership.push(ownership);
      } else if (tag === STATE_CLUSTER_TAG) {
        const cluster = decodeStateCluster(data);
        if (cluster.worldEpoch === this.#loadedWorldEpoch) this.#deliverCluster(cluster);
        else if (cluster.worldEpoch === this.#worldEpoch && this.#pendingClusters.length < 64)
          this.#pendingClusters.push(cluster);
      } else {
        throw new Error("unknown server binary packet");
      }
    } catch {
      socket.close(4002, "invalid server binary packet");
    }
  }

  #deliverCluster(cluster: StateClusterPacket): void {
    const received = this.#receiver.applyCluster(cluster);
    if (received.accepted.length > 0) this.#callbacks.state(received.accepted, performance.now());
    if (received.ack.entries.length > 0) this.#sendAck(received.ack);
  }

  #sendAck(ack: ReturnType<StateReceiver["applyCluster"]>["ack"]): void {
    const channel = this.#ownerChannel;
    if (channel?.readyState === "open" && channel.bufferedAmount < 16_384)
      channel.send(encodeStateAck(ack));
  }

  async #acceptRtcOffer(socket: WebSocket, message: RtcOfferMessage): Promise<void> {
    if (this.#socket !== socket || message.worldEpoch !== this.#worldEpoch || this.#peerConnection)
      return;
    this.#closeRtc();
    this.#callbacks.transport?.("negotiating");
    const peer = new RTCPeerConnection({ iceServers: message.iceServers });
    const owner = peer.createDataChannel("gurgur-owner-v5", {
      ordered: false,
      maxRetransmits: 0,
    });
    owner.addEventListener("open", () => this.#maybeTransportReady());
    peer.addEventListener("datachannel", (event) => {
      const state = event.channel;
      if (
        this.#peerConnection !== peer ||
        state.label !== "gurgur-state-v5" ||
        this.#stateChannel
      ) {
        state.close();
        return;
      }
      this.#stateChannel = state;
      state.binaryType = "arraybuffer";
      state.addEventListener("open", () => this.#maybeTransportReady());
      state.addEventListener("message", (messageEvent) => {
        if (this.#peerConnection !== peer || !(messageEvent.data instanceof ArrayBuffer)) return;
        this.#defer(() => {
          if (this.#peerConnection === peer)
            this.#handleBinary(socket, messageEvent.data as ArrayBuffer);
        });
      });
    });
    peer.addEventListener("connectionstatechange", () => {
      if (this.#peerConnection === peer && peer.connectionState === "failed")
        socket.close(4012, "state transport failed");
    });
    this.#peerConnection = peer;
    this.#ownerChannel = owner;
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

  #maybeTransportReady(): void {
    if (
      !this.#transportReady &&
      this.#ownerChannel?.readyState === "open" &&
      this.#stateChannel?.readyState === "open"
    ) {
      this.#transportReady = true;
      this.#callbacks.transport?.("webrtc");
    }
  }

  #closeRtc(): void {
    if (this.#peerConnection) this.#callbacks.transport?.("disconnected");
    this.#ownerChannel?.close();
    this.#stateChannel?.close();
    this.#peerConnection?.close();
    this.#ownerChannel = null;
    this.#stateChannel = null;
    this.#peerConnection = null;
    this.#transportReady = false;
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
      this.#loadedWorldEpoch = message.worldEpoch;
      for (const lifecycle of this.#pendingLifecycles) this.#callbacks.lifecycle(lifecycle);
      this.#pendingLifecycles = [];
      if (this.#pendingBootstrap?.worldEpoch === message.worldEpoch) {
        this.#receiver.reset(this.#pendingBootstrap.states);
        this.#callbacks.bootstrap(this.#pendingBootstrap.states, performance.now());
      }
      this.#pendingBootstrap = null;
      for (const ownership of this.#pendingOwnership)
        this.#callbacks.ownership(ownership, performance.now());
      this.#pendingOwnership = [];
      for (const cluster of this.#pendingClusters) this.#deliverCluster(cluster);
      this.#pendingClusters = [];
      this.#callbacks.status("connected");
    } catch {
      if (generation === this.#worldLoadGeneration) socket.close(4011, "world load failed");
    }
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
    const value = Number(sessionStorage.getItem("gurgur.socket-generation") ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
