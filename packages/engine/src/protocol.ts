import { PROTOCOL_VERSION } from "./config";
import type { InputCommand, Snapshot } from "./types";
import type { LifecycleMessage, RuntimeEntityRef } from "./world";

export const SNAPSHOT_TAG = 1;
export const INPUT_TAG = 2;
export const LIFECYCLE_TAG = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeLifecycle(message: LifecycleMessage): ArrayBuffer {
  return encodeTaggedJson(LIFECYCLE_TAG, message);
}

export function decodeLifecycle(bytes: ArrayBuffer | ArrayBufferView): LifecycleMessage {
  const value = decodeTaggedJson(bytes, LIFECYCLE_TAG);
  if (
    !isObject(value) ||
    value.type !== "lifecycle" ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.worldEpoch) ||
    !Array.isArray(value.created) ||
    !value.created.every(isRuntimeEntityRef) ||
    !Array.isArray(value.removed) ||
    !value.removed.every(isRuntimeId)
  ) {
    throw new Error("invalid lifecycle packet");
  }
  return value as LifecycleMessage;
}

export function encodeInput(command: InputCommand): ArrayBuffer {
  return encodeTaggedJson(INPUT_TAG, command);
}

export function decodeInput(bytes: ArrayBuffer | ArrayBufferView): InputCommand {
  const value = decodeTaggedJson(bytes, INPUT_TAG);
  if (
    !isObject(value) ||
    value.type !== "input" ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.worldEpoch) ||
    !Number.isSafeInteger(value.sequence)
  ) {
    throw new Error("invalid input packet");
  }
  return value as InputCommand;
}

export function encodeSnapshot(snapshot: Snapshot): ArrayBuffer {
  return encodeTaggedJson(SNAPSHOT_TAG, snapshot);
}

export function decodeSnapshot(bytes: ArrayBuffer | ArrayBufferView): Snapshot {
  const value = decodeTaggedJson(bytes, SNAPSHOT_TAG);
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.worldEpoch) ||
    !Number.isSafeInteger(value.serverTick) ||
    !Array.isArray(value.bodies) ||
    !Array.isArray(value.players)
  ) {
    throw new Error("invalid snapshot packet");
  }
  return value as Snapshot;
}

function encodeTaggedJson(tag: number, value: unknown): ArrayBuffer {
  const payload = encoder.encode(JSON.stringify(value));
  const bytes = new Uint8Array(payload.byteLength + 1);
  bytes[0] = tag;
  bytes.set(payload, 1);
  return bytes.buffer;
}

function decodeTaggedJson(bytes: ArrayBuffer | ArrayBufferView, expectedTag: number): unknown {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 2 || view[0] !== expectedTag) throw new Error("unknown binary packet tag");
  return JSON.parse(decoder.decode(view.subarray(1)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeId(value: unknown): boolean {
  return (
    isObject(value) && Number.isSafeInteger(value.index) && Number.isSafeInteger(value.generation)
  );
}

function isRuntimeEntityRef(value: unknown): value is RuntimeEntityRef {
  return (
    isObject(value) &&
    isRuntimeId(value.id) &&
    (value.kind === "player" ||
      (value.kind === "world-entity" && Number.isSafeInteger(value.entityIndex)))
  );
}
