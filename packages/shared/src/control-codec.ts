import { PROTOCOL_VERSION } from "./config";
import type {
  ClientControlMessage, HelloMessage, PingMessage, PongMessage, VoiceBlockMessage, VoicePeersMessage,
  VoiceReadyMessage, VoiceSignalForwardMessage, VoiceSignalMessage, WelcomeMessage,
} from "./types";
import type { RuntimeEntity, WorldManifestMessage } from "./world";

type RecordValue = Record<string, unknown>;

export function decodeClientControl(text: string): ClientControlMessage {
  if (text.length === 0 || text.length > 32_768) throw new Error("control packet length is invalid");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("control packet is not valid JSON");
  }
  if (!record(value) || typeof value.type !== "string") throw new Error("control packet must be an object with a type");
  if (value.protocolVersion !== PROTOCOL_VERSION) throw new Error("control protocol version mismatch");
  if (value.type === "hello") return hello(value);
  if (value.type === "ping") return ping(value);
  if (value.type === "voice-ready") return voiceReady(value);
  if (value.type === "voice-block") return voiceBlock(value);
  if (value.type === "voice-signal") return voiceSignal(value);
  throw new Error("unknown control packet type");
}

export type ServerTextMessage = WelcomeMessage | PongMessage | VoicePeersMessage
  | VoiceSignalForwardMessage | WorldManifestMessage;

export function decodeServerControl(text: string): ServerTextMessage {
  const value = parseControl(text);
  if (value.type === "welcome") return welcome(value);
  if (value.type === "world") return world(value);
  if (value.type === "pong") return pong(value);
  if (value.type === "voice-peers") return voicePeers(value);
  if (value.type === "voice-signal") return voiceSignalForward(value);
  throw new Error("unknown control packet type");
}

function parseControl(text: string): RecordValue {
  if (text.length === 0 || text.length > 32_768) throw new Error("control packet length is invalid");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("control packet is not valid JSON");
  }
  if (!record(value) || typeof value.type !== "string") throw new Error("control packet must be an object with a type");
  if (value.protocolVersion !== PROTOCOL_VERSION) throw new Error("control protocol version mismatch");
  return value;
}

function hello(value: RecordValue): HelloMessage {
  exact(value, ["type", "protocolVersion", "mapRevision", "worldEpoch", "sessionToken", "socketGeneration"]);
  if (!nullableString(value.mapRevision, 128) || !nullableSafeInteger(value.worldEpoch, 0)
    || !nullableString(value.sessionToken, 128) || !safeInteger(value.socketGeneration, 0)) {
    throw new Error("hello fields are invalid");
  }
  return value as HelloMessage;
}

function welcome(value: RecordValue): WelcomeMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "playerId", "mapRevision", "physicsHz", "snapshotHz",
    "sessionToken", "socketGeneration", "peerId", "voiceConfig"]);
  if (!safeInteger(value.worldEpoch, 0) || !runtimeId(value.playerId) || !string(value.mapRevision, 128, 1)
    || !finitePositive(value.physicsHz) || !finitePositive(value.snapshotHz) || !string(value.sessionToken, 128, 16)
    || !safeInteger(value.socketGeneration, 0) || !string(value.peerId, 128, 1) || !record(value.voiceConfig)) {
    throw new Error("welcome fields are invalid");
  }
  exact(value.voiceConfig, ["iceServers", "iceTransportPolicy"]);
  if (!Array.isArray(value.voiceConfig.iceServers) || value.voiceConfig.iceServers.length > 16
    || !["all", "relay"].includes(String(value.voiceConfig.iceTransportPolicy))) {
    throw new Error("voice configuration is invalid");
  }
  for (const server of value.voiceConfig.iceServers) {
    if (!record(server)) throw new Error("ICE server is invalid");
    exact(server, ["urls", "username", "credential"]);
    const urlsValid = string(server.urls, 2_048, 1)
      || (Array.isArray(server.urls) && server.urls.length > 0 && server.urls.length <= 16
        && server.urls.every((url) => string(url, 2_048, 1)));
    if (!urlsValid || !optionalString(server.username, 512) || !optionalString(server.credential, 2_048)) {
      throw new Error("ICE server is invalid");
    }
  }
  return value as WelcomeMessage;
}

function world(value: RecordValue): WorldManifestMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "mapRevision", "bundleUrl", "runtimeEntities"]);
  if (!safeInteger(value.worldEpoch, 0) || !string(value.mapRevision, 128, 1) || !string(value.bundleUrl, 2_048, 1)
    || !Array.isArray(value.runtimeEntities) || value.runtimeEntities.length > 65_535) {
    throw new Error("world fields are invalid");
  }
  for (const entity of value.runtimeEntities) validateRuntimeEntity(entity);
  return value as WorldManifestMessage;
}

function pong(value: RecordValue): PongMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "nonce", "sentAtMs", "serverTick"]);
  if (!safeInteger(value.worldEpoch, 0) || !safeInteger(value.nonce, 0) || !finite(value.sentAtMs)
    || !safeInteger(value.serverTick, 0)) throw new Error("pong fields are invalid");
  return value as PongMessage;
}

function voicePeers(value: RecordValue): VoicePeersMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "peers"]);
  if (!safeInteger(value.worldEpoch, 0) || !Array.isArray(value.peers) || value.peers.length > 64) {
    throw new Error("voice-peers fields are invalid");
  }
  for (const peer of value.peers) {
    if (!record(peer)) throw new Error("voice peer is invalid");
    exact(peer, ["peerId", "distance", "relative", "polite"]);
    if (!string(peer.peerId, 128, 1) || !finite(peer.distance) || peer.distance < 0
      || !vec3(peer.relative) || typeof peer.polite !== "boolean") throw new Error("voice peer is invalid");
  }
  return value as VoicePeersMessage;
}

function voiceSignalForward(value: RecordValue): VoiceSignalForwardMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "fromPeerId", "signal"]);
  if (!safeInteger(value.worldEpoch, 0) || !string(value.fromPeerId, 128, 1) || !record(value.signal)) {
    throw new Error("voice-signal fields are invalid");
  }
  validateVoiceSignal(value.signal);
  return value as VoiceSignalForwardMessage;
}

function ping(value: RecordValue): PingMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "nonce", "sentAtMs"]);
  if (!safeInteger(value.worldEpoch, 0) || !safeInteger(value.nonce, 0) || !finite(value.sentAtMs)) {
    throw new Error("ping fields are invalid");
  }
  return value as PingMessage;
}

function voiceReady(value: RecordValue): VoiceReadyMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "enabled"]);
  if (!safeInteger(value.worldEpoch, 0) || typeof value.enabled !== "boolean") throw new Error("voice-ready fields are invalid");
  return value as VoiceReadyMessage;
}

function voiceBlock(value: RecordValue): VoiceBlockMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "peerId", "blocked"]);
  if (!safeInteger(value.worldEpoch, 0) || !string(value.peerId, 128, 1) || typeof value.blocked !== "boolean") {
    throw new Error("voice-block fields are invalid");
  }
  return value as VoiceBlockMessage;
}

function voiceSignal(value: RecordValue): VoiceSignalMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "toPeerId", "signal"]);
  if (!safeInteger(value.worldEpoch, 0) || !string(value.toPeerId, 128, 1) || !record(value.signal)) {
    throw new Error("voice-signal fields are invalid");
  }
  validateVoiceSignal(value.signal);
  return value as VoiceSignalMessage;
}

function validateVoiceSignal(signal: RecordValue): void {
  exact(signal, ["description", "candidate"]);
  if (signal.description !== undefined) {
    if (!record(signal.description)) throw new Error("voice description is invalid");
    exact(signal.description, ["type", "sdp"]);
    if (!["offer", "answer", "pranswer", "rollback"].includes(String(signal.description.type))
      || (signal.description.sdp !== undefined && !string(signal.description.sdp, 16_000))) {
      throw new Error("voice description is invalid");
    }
  }
  if (signal.candidate !== undefined) {
    if (!record(signal.candidate)) throw new Error("voice candidate is invalid");
    exact(signal.candidate, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"]);
    if (!string(signal.candidate.candidate, 4_096)
      || !nullableOptionalString(signal.candidate.sdpMid, 256)
      || !nullableOptionalSafeInteger(signal.candidate.sdpMLineIndex, 0)
      || !nullableOptionalString(signal.candidate.usernameFragment, 256)) {
      throw new Error("voice candidate is invalid");
    }
  }
  if (signal.description === undefined && signal.candidate === undefined) throw new Error("voice signal is empty");
}

function validateRuntimeEntity(value: unknown): asserts value is RuntimeEntity {
  if (!record(value)) throw new Error("runtime entity is invalid");
  const physical = ["func_physics", "func_door", "func_platform", "func_button"].includes(String(value.classname));
  exact(value, physical ? ["id", "authoredId", "classname", "brushIndex", "brushIndices"] : ["id", "authoredId", "classname"]);
  if (!runtimeId(value.id) || !string(value.authoredId, 512, 1)) throw new Error("runtime entity is invalid");
  if (physical) {
    if (!safeInteger(value.brushIndex, 0) || (value.brushIndices !== undefined && (
      !Array.isArray(value.brushIndices) || value.brushIndices.length === 0 || value.brushIndices.length > 1_024
      || !value.brushIndices.every((index) => safeInteger(index, 0))
    ))) throw new Error("runtime entity is invalid");
  } else if (value.classname !== "player") throw new Error("runtime entity classname is invalid");
}

function runtimeId(value: unknown): boolean {
  if (!record(value)) return false;
  exact(value, ["index", "generation"]);
  return safeInteger(value.index, 0) && safeInteger(value.generation, 0);
}

function vec3(value: unknown): boolean {
  if (!record(value)) return false;
  exact(value, ["x", "y", "z"]);
  return finite(value.x) && finite(value.y) && finite(value.z);
}

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: RecordValue, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error("control packet has unknown fields");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePositive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function string(value: unknown, maximum: number, minimum = 0): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function nullableString(value: unknown, maximum: number): value is string | null {
  return value === null || string(value, maximum);
}

function optionalString(value: unknown, maximum: number): boolean {
  return value === undefined || string(value, maximum);
}

function nullableSafeInteger(value: unknown, minimum: number): value is number | null {
  return value === null || safeInteger(value, minimum);
}

function nullableOptionalString(value: unknown, maximum: number): boolean {
  return value === undefined || value === null || string(value, maximum);
}

function nullableOptionalSafeInteger(value: unknown, minimum: number): boolean {
  return value === undefined || value === null || safeInteger(value, minimum);
}
