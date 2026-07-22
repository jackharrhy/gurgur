import {
  PROTOCOL_VERSION,
  type VoiceBlockMessage,
  type VoicePeersMessage,
  type VoiceReadyMessage,
  type VoiceSignalForwardMessage,
  type VoiceSignalMessage,
  type WelcomeMessage,
} from "@gurgur/shared";

type Peer = {
  id: string;
  connection: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  gain: GainNode | null;
  panner: PannerNode | null;
};

export class VoiceChat {
  readonly #send: (message: VoiceReadyMessage | VoiceBlockMessage | VoiceSignalMessage) => void;
  readonly #status: (status: string) => void;
  #welcome: WelcomeMessage | null = null;
  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #outboundStream: MediaStream | null = null;
  #microphoneSource: MediaStreamAudioSourceNode | null = null;
  #microphoneGain: GainNode | null = null;
  #enabled = false;
  #desiredPeers = new Map<string, VoicePeersMessage["peers"][number]>();
  readonly #peers = new Map<string, Peer>();

  constructor(
    send: (message: VoiceReadyMessage | VoiceBlockMessage | VoiceSignalMessage) => void,
    status: (status: string) => void = () => {},
  ) {
    this.#send = send;
    this.#status = status;
  }

  get enabled(): boolean { return this.#enabled; }

  configure(welcome: WelcomeMessage): void {
    if (this.#welcome?.worldEpoch !== welcome.worldEpoch) this.#closePeers();
    this.#welcome = welcome;
  }

  async enable(): Promise<void> {
    if (this.#enabled || !this.#welcome) return;
    try {
      this.#context ??= new AudioContext();
      await this.#context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.#stream = stream;
      this.#microphoneSource = this.#context.createMediaStreamSource(stream);
      this.#microphoneGain = this.#context.createGain();
      const destination = this.#context.createMediaStreamDestination();
      this.#microphoneSource.connect(this.#microphoneGain).connect(destination);
      this.#outboundStream = destination.stream;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => {
        if (this.#stream === stream) this.disable("device lost");
      }, { once: true });
      this.#enabled = true;
      this.#sendReady(true);
      this.#status("voice on");
      this.#syncPeers();
    } catch (error) {
      this.disable(`voice unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  disable(reason = "voice off"): void {
    if (this.#enabled) this.#sendReady(false);
    this.#enabled = false;
    this.#closePeers();
    for (const track of this.#outboundStream?.getTracks() ?? []) track.stop();
    this.#outboundStream = null;
    this.#microphoneSource?.disconnect();
    this.#microphoneGain?.disconnect();
    this.#microphoneSource = null;
    this.#microphoneGain = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    this.#status(reason);
  }

  setMuted(muted: boolean): void {
    if (this.#microphoneGain) this.#microphoneGain.gain.value = muted ? 0 : 1;
    this.#status(muted ? "voice muted" : "voice on");
  }

  block(peerId: string, blocked: boolean): void {
    if (!this.#welcome) return;
    this.#send({
      type: "voice-block", protocolVersion: PROTOCOL_VERSION, worldEpoch: this.#welcome.worldEpoch,
      peerId, blocked,
    });
    if (blocked) this.#removePeer(peerId);
  }

  updatePeers(message: VoicePeersMessage): void {
    if (!this.#welcome || message.worldEpoch !== this.#welcome.worldEpoch) return;
    this.#desiredPeers = new Map(message.peers.map((peer) => [peer.peerId, peer]));
    this.#syncPeers();
  }

  async handleSignal(message: VoiceSignalForwardMessage): Promise<void> {
    if (!this.#enabled || !this.#desiredPeers.has(message.fromPeerId)) return;
    const peer = this.#peers.get(message.fromPeerId) ?? this.#addPeer(this.#desiredPeers.get(message.fromPeerId)!);
    try {
      if (message.signal.description) {
        const description = message.signal.description as RTCSessionDescriptionInit;
        const collision = description.type === "offer"
          && (peer.makingOffer || peer.connection.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await peer.connection.setRemoteDescription(description);
        if (description.type === "offer") {
          await peer.connection.setLocalDescription();
          this.#sendSignal(peer.id, { description: peer.connection.localDescription!.toJSON() });
        }
      } else if (message.signal.candidate) {
        try { await peer.connection.addIceCandidate(message.signal.candidate); } catch (error) {
          if (!peer.ignoreOffer) throw error;
        }
      }
    } catch (error) {
      this.#status(`voice peer error: ${error instanceof Error ? error.message : String(error)}`);
      this.#removePeer(peer.id);
    }
  }

  dispose(): void {
    this.disable();
    void this.#context?.close();
    this.#context = null;
  }

  #sendReady(enabled: boolean): void {
    if (!this.#welcome) return;
    this.#send({ type: "voice-ready", protocolVersion: PROTOCOL_VERSION, worldEpoch: this.#welcome.worldEpoch, enabled });
  }

  #syncPeers(): void {
    for (const id of this.#peers.keys()) if (!this.#enabled || !this.#desiredPeers.has(id)) this.#removePeer(id);
    if (!this.#enabled) return;
    for (const desired of this.#desiredPeers.values()) {
      const peer = this.#peers.get(desired.peerId) ?? this.#addPeer(desired);
      peer.polite = desired.polite;
      if (peer.gain) peer.gain.gain.value = desired.distance <= 3 ? 1 : Math.max(0, (20 - desired.distance) / 17);
      if (peer.panner) {
        peer.panner.positionX.value = desired.relative.x;
        peer.panner.positionY.value = desired.relative.y;
        peer.panner.positionZ.value = desired.relative.z;
      }
    }
    const mediaPeers = [...this.#peers.values()].filter((peer) => peer.gain !== null).length;
    this.#status(`voice on · ${this.#peers.size} peer${this.#peers.size === 1 ? "" : "s"} · ${mediaPeers} media`);
  }

  #addPeer(desired: VoicePeersMessage["peers"][number]): Peer {
    if (!this.#welcome || !this.#outboundStream || !this.#context) throw new Error("voice is not configured");
    const connection = new RTCPeerConnection({
      iceServers: this.#welcome.voiceConfig.iceServers,
      iceTransportPolicy: this.#welcome.voiceConfig.iceTransportPolicy,
    });
    const peer: Peer = {
      id: desired.peerId, connection, polite: desired.polite,
      makingOffer: false, ignoreOffer: false, gain: null, panner: null,
    };
    this.#peers.set(peer.id, peer);
    for (const track of this.#outboundStream.getTracks()) connection.addTrack(track, this.#outboundStream);
    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate) this.#sendSignal(peer.id, { candidate: {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
      } });
    });
    connection.addEventListener("track", (event) => {
      const source = this.#context!.createMediaStreamSource(event.streams[0] ?? new MediaStream([event.track]));
      const panner = this.#context!.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "linear";
      panner.refDistance = 3;
      panner.maxDistance = 20;
      panner.rolloffFactor = 1;
      const gain = this.#context!.createGain();
      source.connect(panner).connect(gain).connect(this.#context!.destination);
      peer.panner = panner;
      peer.gain = gain;
      this.#syncPeers();
    });
    connection.addEventListener("connectionstatechange", () => {
      this.#status(`voice ${connection.connectionState} · ${this.#peers.size} peer${this.#peers.size === 1 ? "" : "s"}`);
      if (["failed", "closed"].includes(connection.connectionState)) this.#removePeer(peer.id);
    });
    if (!peer.polite) void this.#offer(peer);
    return peer;
  }

  async #offer(peer: Peer): Promise<void> {
    try {
      peer.makingOffer = true;
      await peer.connection.setLocalDescription();
      this.#sendSignal(peer.id, { description: peer.connection.localDescription!.toJSON() });
    } finally {
      peer.makingOffer = false;
    }
  }

  #sendSignal(toPeerId: string, signal: VoiceSignalMessage["signal"]): void {
    if (!this.#welcome) return;
    this.#send({
      type: "voice-signal", protocolVersion: PROTOCOL_VERSION, worldEpoch: this.#welcome.worldEpoch,
      toPeerId, signal,
    });
  }

  #removePeer(id: string): void {
    const peer = this.#peers.get(id);
    if (!peer) return;
    this.#peers.delete(id);
    peer.connection.close();
    peer.gain?.disconnect();
    peer.panner?.disconnect();
  }

  #closePeers(): void {
    for (const id of [...this.#peers.keys()]) this.#removePeer(id);
  }
}
