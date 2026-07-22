import { PROTOCOL_VERSION } from "./config";
import type { Snapshot } from "./types";
import type { LifecycleMessage, RuntimeEntity } from "./world";
import type { InputCommand } from "./types";

export const SNAPSHOT_TAG = 1;
export const INPUT_TAG = 2;
export const LIFECYCLE_TAG = 3;
const HEADER_BYTES = 15;
const BODY_BYTES = 61;
const PLAYER_BYTES = 41;
const INPUT_BYTES = 53;
const LIFECYCLE_HEADER_BYTES = 11;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const runtimeClassToTag = {
  func_physics: 1, func_door: 2, func_platform: 3, func_button: 4, player: 5,
} as const;
const runtimeTagToClass = [null, "func_physics", "func_door", "func_platform", "func_button", "player"] as const;

export function encodeLifecycle(message: LifecycleMessage): ArrayBuffer {
  if (message.created.length > 0xffff || message.removed.length > 0xffff) throw new Error("lifecycle entity count exceeds uint16");
  const names = message.created.map((entity) => encoder.encode(entity.authoredId));
  const brushLists = message.created.map((entity) => "brushIndex" in entity ? (entity.brushIndices ?? [entity.brushIndex]) : []);
  if (names.some((name) => name.byteLength > 0xffff)) throw new Error("lifecycle authored ID exceeds uint16");
  if (brushLists.some((indices) => indices.length > 0xffff)) throw new Error("lifecycle brush count exceeds uint16");
  const bytes = new ArrayBuffer(
    LIFECYCLE_HEADER_BYTES + message.created.length * 17
      + names.reduce((sum, name) => sum + name.byteLength, 0)
      + brushLists.reduce((sum, indices) => sum + indices.length * 4, 0)
      + message.removed.length * 8,
  );
  const view = new DataView(bytes);
  view.setUint8(0, LIFECYCLE_TAG);
  view.setUint16(1, message.protocolVersion, true);
  view.setUint32(3, message.worldEpoch, true);
  view.setUint16(7, message.created.length, true);
  view.setUint16(9, message.removed.length, true);
  let offset = LIFECYCLE_HEADER_BYTES;
  for (let index = 0; index < message.created.length; index += 1) {
    const entity = message.created[index]!;
    const name = names[index]!;
    view.setUint8(offset, runtimeClassToTag[entity.classname]);
    view.setUint32(offset + 1, entity.id.index, true);
    view.setUint32(offset + 5, entity.id.generation, true);
    view.setUint32(offset + 9, "brushIndex" in entity ? entity.brushIndex : 0xffff_ffff, true);
    view.setUint16(offset + 13, name.byteLength, true);
    view.setUint16(offset + 15, brushLists[index]!.length, true);
    new Uint8Array(bytes, offset + 17, name.byteLength).set(name);
    offset += 17 + name.byteLength;
    for (const brushIndex of brushLists[index]!) {
      view.setUint32(offset, brushIndex, true);
      offset += 4;
    }
  }
  for (const id of message.removed) {
    view.setUint32(offset, id.index, true);
    view.setUint32(offset + 4, id.generation, true);
    offset += 8;
  }
  return bytes;
}

export function decodeLifecycle(bytes: ArrayBuffer | ArrayBufferView): LifecycleMessage {
  const view = bytes instanceof ArrayBuffer
    ? new DataView(bytes)
    : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < LIFECYCLE_HEADER_BYTES) throw new Error("lifecycle header is truncated");
  if (view.getUint8(0) !== LIFECYCLE_TAG) throw new Error("unknown binary packet tag");
  if (view.getUint16(1, true) !== PROTOCOL_VERSION) throw new Error("lifecycle protocol version mismatch");
  const createdCount = view.getUint16(7, true);
  const removedCount = view.getUint16(9, true);
  const created: RuntimeEntity[] = [];
  let offset = LIFECYCLE_HEADER_BYTES;
  for (let index = 0; index < createdCount; index += 1) {
    if (offset + 17 > view.byteLength) throw new Error("lifecycle entity is truncated");
    const classname = runtimeTagToClass[view.getUint8(offset)];
    if (!classname) throw new Error("lifecycle classname tag is invalid");
    const id = { index: view.getUint32(offset + 1, true), generation: view.getUint32(offset + 5, true) };
    const brushIndex = view.getUint32(offset + 9, true);
    const nameLength = view.getUint16(offset + 13, true);
    const brushCount = view.getUint16(offset + 15, true);
    if (offset + 17 + nameLength + brushCount * 4 > view.byteLength) throw new Error("lifecycle entity is truncated");
    const authoredId = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset + 17, nameLength));
    offset += 17 + nameLength;
    const brushIndices = Array.from({ length: brushCount }, () => {
      const index = view.getUint32(offset, true);
      offset += 4;
      return index;
    });
    if (classname === "player") {
      if (brushIndex !== 0xffff_ffff || brushIndices.length !== 0) throw new Error("lifecycle player has brush data");
      created.push({ id, authoredId, classname });
    }
    else {
      if (brushIndex === 0xffff_ffff) throw new Error("lifecycle brush entity is missing its brush index");
      if (brushIndices.length === 0 || brushIndices[0] !== brushIndex) throw new Error("lifecycle brush list is invalid");
      created.push({ id, authoredId, classname, brushIndex, ...(brushIndices.length > 1 ? { brushIndices } : {}) });
    }
  }
  const removed = [];
  for (let index = 0; index < removedCount; index += 1) {
    if (offset + 8 > view.byteLength) throw new Error("lifecycle removal is truncated");
    removed.push({ index: view.getUint32(offset, true), generation: view.getUint32(offset + 4, true) });
    offset += 8;
  }
  if (offset !== view.byteLength) throw new Error("lifecycle packet has trailing bytes");
  return {
    type: "lifecycle", protocolVersion: view.getUint16(1, true), worldEpoch: view.getUint32(3, true), created, removed,
  };
}

export function encodeInput(command: InputCommand): ArrayBuffer {
  const bytes = new ArrayBuffer(INPUT_BYTES);
  const view = new DataView(bytes);
  view.setUint8(0, INPUT_TAG);
  view.setUint16(1, command.protocolVersion, true);
  view.setUint32(3, command.worldEpoch, true);
  view.setUint32(7, command.sequence, true);
  view.setUint32(11, command.clientTick, true);
  view.setFloat32(15, command.moveX, true);
  view.setFloat32(19, command.moveZ, true);
  view.setFloat32(23, command.lookYaw, true);
  view.setFloat32(27, command.lookPitch, true);
  view.setUint16(31, command.buttons, true);
  view.setUint32(33, command.jumpCounter, true);
  view.setUint32(37, command.interactCounter, true);
  view.setUint32(41, command.interactTarget?.index ?? 0xffff_ffff, true);
  view.setUint32(45, command.interactTarget?.generation ?? 0xffff_ffff, true);
  view.setUint32(49, command.primaryCounter, true);
  return bytes;
}

export function decodeInput(bytes: ArrayBuffer | ArrayBufferView): InputCommand {
  const view = bytes instanceof ArrayBuffer
    ? new DataView(bytes)
    : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength !== INPUT_BYTES) throw new Error("input packet length mismatch");
  if (view.getUint8(0) !== INPUT_TAG) throw new Error("unknown binary packet tag");
  if (view.getUint16(1, true) !== PROTOCOL_VERSION) throw new Error("input protocol version mismatch");
  return {
    type: "input",
    protocolVersion: view.getUint16(1, true),
    worldEpoch: view.getUint32(3, true),
    sequence: view.getUint32(7, true),
    clientTick: view.getUint32(11, true),
    moveX: view.getFloat32(15, true),
    moveZ: view.getFloat32(19, true),
    lookYaw: view.getFloat32(23, true),
    lookPitch: view.getFloat32(27, true),
    buttons: view.getUint16(31, true),
    jumpCounter: view.getUint32(33, true),
    interactCounter: view.getUint32(37, true),
    interactTarget: view.getUint32(41, true) === 0xffff_ffff
      ? null
      : { index: view.getUint32(41, true), generation: view.getUint32(45, true) },
    primaryCounter: view.getUint32(49, true),
  };
}

export function encodeSnapshot(snapshot: Snapshot): ArrayBuffer {
  const playerKeys = new Set(snapshot.players.map((player) => `${player.id.index}:${player.id.generation}`));
  const bodies = snapshot.bodies.filter((body) => !playerKeys.has(`${body.id.index}:${body.id.generation}`));
  const playerBodies = new Map(snapshot.bodies.map((body) => [`${body.id.index}:${body.id.generation}`, body]));
  if (bodies.length > 0xffff) throw new Error("snapshot body count exceeds uint16");
  if (snapshot.players.length > 0xffff) throw new Error("snapshot player count exceeds uint16");
  const bytes = new ArrayBuffer(
    HEADER_BYTES + bodies.length * BODY_BYTES + snapshot.players.length * PLAYER_BYTES,
  );
  const view = new DataView(bytes);
  view.setUint8(0, SNAPSHOT_TAG);
  view.setUint16(1, PROTOCOL_VERSION, true);
  view.setUint32(3, snapshot.worldEpoch, true);
  view.setUint32(7, snapshot.serverTick, true);
  view.setUint16(11, bodies.length, true);
  view.setUint16(13, snapshot.players.length, true);

  let offset = HEADER_BYTES;
  for (const body of bodies) {
    view.setUint32(offset, body.id.index, true);
    view.setUint32(offset + 4, body.id.generation, true);
    view.setFloat32(offset + 8, body.position.x, true);
    view.setFloat32(offset + 12, body.position.y, true);
    view.setFloat32(offset + 16, body.position.z, true);
    view.setFloat32(offset + 20, body.rotation.x, true);
    view.setFloat32(offset + 24, body.rotation.y, true);
    view.setFloat32(offset + 28, body.rotation.z, true);
    view.setFloat32(offset + 32, body.rotation.w, true);
    view.setFloat32(offset + 36, body.linearVelocity?.x ?? 0, true);
    view.setFloat32(offset + 40, body.linearVelocity?.y ?? 0, true);
    view.setFloat32(offset + 44, body.linearVelocity?.z ?? 0, true);
    view.setFloat32(offset + 48, body.angularVelocity?.x ?? 0, true);
    view.setFloat32(offset + 52, body.angularVelocity?.y ?? 0, true);
    view.setFloat32(offset + 56, body.angularVelocity?.z ?? 0, true);
    view.setUint8(offset + 60, body.flags ?? 0);
    offset += BODY_BYTES;
  }
  for (const player of snapshot.players) {
    view.setUint32(offset, player.id.index, true);
    view.setUint32(offset + 4, player.id.generation, true);
    view.setFloat32(offset + 8, player.position.x, true);
    view.setFloat32(offset + 12, player.position.y, true);
    view.setFloat32(offset + 16, player.position.z, true);
    view.setFloat32(offset + 20, player.yaw, true);
    view.setFloat32(offset + 24, player.verticalVelocity, true);
    view.setUint32(offset + 28, player.lastProcessedInputSequence < 0 ? 0xffff_ffff : player.lastProcessedInputSequence, true);
    view.setUint32(offset + 32, player.lastJumpCounter, true);
    view.setUint16(offset + 36, player.stepCooldown, true);
    view.setUint8(offset + 38, Number(player.grounded));
    view.setUint8(offset + 39, Number(player.crouched));
    view.setUint8(offset + 40, playerBodies.get(`${player.id.index}:${player.id.generation}`)?.flags ?? 0);
    offset += PLAYER_BYTES;
  }
  return bytes;
}

export function decodeSnapshot(bytes: ArrayBuffer): Snapshot {
  if (bytes.byteLength < HEADER_BYTES) throw new Error("snapshot header is truncated");
  const view = new DataView(bytes);
  if (view.getUint8(0) !== SNAPSHOT_TAG) throw new Error("unknown binary packet tag");
  if (view.getUint16(1, true) !== PROTOCOL_VERSION) throw new Error("snapshot protocol version mismatch");
  const bodyCount = view.getUint16(11, true);
  const playerCount = view.getUint16(13, true);
  if (bytes.byteLength !== HEADER_BYTES + bodyCount * BODY_BYTES + playerCount * PLAYER_BYTES) {
    throw new Error("snapshot length mismatch");
  }

  const bodies: Snapshot["bodies"] = [];
  let offset = HEADER_BYTES;
  for (let index = 0; index < bodyCount; index += 1) {
    bodies.push({
      id: {
        index: view.getUint32(offset, true),
        generation: view.getUint32(offset + 4, true),
      },
      position: {
        x: view.getFloat32(offset + 8, true),
        y: view.getFloat32(offset + 12, true),
        z: view.getFloat32(offset + 16, true),
      },
      rotation: {
        x: view.getFloat32(offset + 20, true),
        y: view.getFloat32(offset + 24, true),
        z: view.getFloat32(offset + 28, true),
        w: view.getFloat32(offset + 32, true),
      },
      linearVelocity: {
        x: view.getFloat32(offset + 36, true),
        y: view.getFloat32(offset + 40, true),
        z: view.getFloat32(offset + 44, true),
      },
      angularVelocity: {
        x: view.getFloat32(offset + 48, true),
        y: view.getFloat32(offset + 52, true),
        z: view.getFloat32(offset + 56, true),
      },
      flags: view.getUint8(offset + 60),
    });
    offset += BODY_BYTES;
  }

  const players: Snapshot["players"] = [];
  for (let index = 0; index < playerCount; index += 1) {
    const acknowledged = view.getUint32(offset + 28, true);
    const player = {
      id: { index: view.getUint32(offset, true), generation: view.getUint32(offset + 4, true) },
      position: {
        x: view.getFloat32(offset + 8, true),
        y: view.getFloat32(offset + 12, true),
        z: view.getFloat32(offset + 16, true),
      },
      yaw: view.getFloat32(offset + 20, true),
      verticalVelocity: view.getFloat32(offset + 24, true),
      lastProcessedInputSequence: acknowledged === 0xffff_ffff ? -1 : acknowledged,
      lastJumpCounter: view.getUint32(offset + 32, true),
      stepCooldown: view.getUint16(offset + 36, true),
      grounded: view.getUint8(offset + 38) !== 0,
      crouched: view.getUint8(offset + 39) !== 0,
    };
    players.push(player);
    bodies.push({
      id: { ...player.id },
      position: { ...player.position },
      rotation: { x: 0, y: Math.sin(player.yaw / 2), z: 0, w: Math.cos(player.yaw / 2) },
      linearVelocity: { x: 0, y: player.verticalVelocity, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      flags: view.getUint8(offset + 40),
    });
    offset += PLAYER_BYTES;
  }

  return {
    worldEpoch: view.getUint32(3, true),
    serverTick: view.getUint32(7, true),
    bodies,
    players,
  };
}
