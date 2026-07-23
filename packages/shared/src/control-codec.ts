import { PROTOCOL_VERSION } from "./config";
import type {
  ClientControlMessage,
  HelloMessage,
  PingMessage,
  PongMessage,
  RtcAnswerMessage,
  RtcOfferMessage,
  WelcomeMessage,
} from "./types";
import type { RuntimeEntity, WorldManifestMessage } from "./world";

type RecordValue = Record<string, unknown>;

export function decodeClientControl(text: string): ClientControlMessage {
  if (text.length === 0 || text.length > 32_768)
    throw new Error("control packet length is invalid");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("control packet is not valid JSON");
  }
  if (!record(value) || typeof value.type !== "string")
    throw new Error("control packet must be an object with a type");
  if (value.protocolVersion !== PROTOCOL_VERSION)
    throw new Error("control protocol version mismatch");
  if (value.type === "hello") return hello(value);
  if (value.type === "ping") return ping(value);
  if (value.type === "rtc-offer") return rtcOffer(value);
  throw new Error("unknown control packet type");
}

export type ServerTextMessage =
  | WelcomeMessage
  | PongMessage
  | RtcAnswerMessage
  | WorldManifestMessage;

export function decodeServerControl(text: string): ServerTextMessage {
  const value = parseControl(text);
  if (value.type === "welcome") return welcome(value);
  if (value.type === "world") return world(value);
  if (value.type === "pong") return pong(value);
  if (value.type === "rtc-answer") return rtcAnswer(value);
  throw new Error("unknown control packet type");
}

function parseControl(text: string): RecordValue {
  if (text.length === 0 || text.length > 32_768)
    throw new Error("control packet length is invalid");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("control packet is not valid JSON");
  }
  if (!record(value) || typeof value.type !== "string")
    throw new Error("control packet must be an object with a type");
  if (value.protocolVersion !== PROTOCOL_VERSION)
    throw new Error("control protocol version mismatch");
  return value;
}

function hello(value: RecordValue): HelloMessage {
  exact(value, [
    "type",
    "protocolVersion",
    "mapRevision",
    "worldEpoch",
    "sessionToken",
    "socketGeneration",
  ]);
  if (
    !nullableString(value.mapRevision, 128) ||
    !nullableSafeInteger(value.worldEpoch, 0) ||
    !nullableString(value.sessionToken, 128) ||
    !safeInteger(value.socketGeneration, 0)
  ) {
    throw new Error("hello fields are invalid");
  }
  return value as HelloMessage;
}

function welcome(value: RecordValue): WelcomeMessage {
  exact(value, [
    "type",
    "protocolVersion",
    "worldEpoch",
    "playerId",
    "mapRevision",
    "physicsHz",
    "snapshotHz",
    "sessionToken",
    "socketGeneration",
  ]);
  if (
    !safeInteger(value.worldEpoch, 0) ||
    !runtimeId(value.playerId) ||
    !string(value.mapRevision, 128, 1) ||
    !finitePositive(value.physicsHz) ||
    !finitePositive(value.snapshotHz) ||
    !string(value.sessionToken, 128, 16) ||
    !safeInteger(value.socketGeneration, 0)
  ) {
    throw new Error("welcome fields are invalid");
  }
  return value as WelcomeMessage;
}

function world(value: RecordValue): WorldManifestMessage {
  exact(value, [
    "type",
    "protocolVersion",
    "worldEpoch",
    "mapRevision",
    "bundleUrl",
    "runtimeEntities",
  ]);
  if (
    !safeInteger(value.worldEpoch, 0) ||
    !string(value.mapRevision, 128, 1) ||
    !string(value.bundleUrl, 2_048, 1) ||
    !Array.isArray(value.runtimeEntities) ||
    value.runtimeEntities.length > 65_535
  ) {
    throw new Error("world fields are invalid");
  }
  for (const entity of value.runtimeEntities) validateRuntimeEntity(entity);
  return value as WorldManifestMessage;
}

function pong(value: RecordValue): PongMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "nonce", "sentAtMs", "serverTick"]);
  if (
    !safeInteger(value.worldEpoch, 0) ||
    !safeInteger(value.nonce, 0) ||
    !finite(value.sentAtMs) ||
    !safeInteger(value.serverTick, 0)
  )
    throw new Error("pong fields are invalid");
  return value as PongMessage;
}

function ping(value: RecordValue): PingMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "nonce", "sentAtMs"]);
  if (
    !safeInteger(value.worldEpoch, 0) ||
    !safeInteger(value.nonce, 0) ||
    !finite(value.sentAtMs)
  ) {
    throw new Error("ping fields are invalid");
  }
  return value as PingMessage;
}

function rtcOffer(value: RecordValue): RtcOfferMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "description"]);
  if (!safeInteger(value.worldEpoch, 0) || !sessionDescription(value.description, "offer")) {
    throw new Error("RTC offer fields are invalid");
  }
  return value as RtcOfferMessage;
}

function rtcAnswer(value: RecordValue): RtcAnswerMessage {
  exact(value, ["type", "protocolVersion", "worldEpoch", "description"]);
  if (!safeInteger(value.worldEpoch, 0) || !sessionDescription(value.description, "answer")) {
    throw new Error("RTC answer fields are invalid");
  }
  return value as RtcAnswerMessage;
}

function sessionDescription(value: unknown, type: "offer" | "answer"): boolean {
  if (!record(value)) return false;
  exact(value, ["type", "sdp"]);
  return value.type === type && string(value.sdp, 32_768, 1);
}

function validateRuntimeEntity(value: unknown): asserts value is RuntimeEntity {
  if (!record(value)) throw new Error("runtime entity is invalid");
  const physical = ["func_physics", "func_door", "func_platform", "func_button"].includes(
    String(value.classname),
  );
  exact(
    value,
    physical
      ? ["id", "authoredId", "classname", "brushIndex", "brushIndices"]
      : ["id", "authoredId", "classname"],
  );
  if (!runtimeId(value.id) || !string(value.authoredId, 512, 1))
    throw new Error("runtime entity is invalid");
  if (physical) {
    if (
      !safeInteger(value.brushIndex, 0) ||
      (value.brushIndices !== undefined &&
        (!Array.isArray(value.brushIndices) ||
          value.brushIndices.length === 0 ||
          value.brushIndices.length > 1_024 ||
          !value.brushIndices.every((index) => safeInteger(index, 0))))
    )
      throw new Error("runtime entity is invalid");
  } else if (value.classname !== "player") throw new Error("runtime entity classname is invalid");
}

function runtimeId(value: unknown): boolean {
  if (!record(value)) return false;
  exact(value, ["index", "generation"]);
  return safeInteger(value.index, 0) && safeInteger(value.generation, 0);
}

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: RecordValue, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error("control packet has unknown fields");
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

function nullableSafeInteger(value: unknown, minimum: number): value is number | null {
  return value === null || safeInteger(value, minimum);
}
