import { PROTOCOL_VERSION } from "./config";
import type { Snapshot } from "./types";
import type { LifecycleMessage, RuntimeEntity } from "./world";
import type { InputCommand } from "./types";

export const SNAPSHOT_TAG = 1;
export const INPUT_TAG = 2;
export const LIFECYCLE_TAG = 3;
export const SNAPSHOT_HEADER_BYTES = 15;
export const SNAPSHOT_BODY_BYTES = 41;
export const SNAPSHOT_PLAYER_BYTES = 36;
const HEADER_BYTES = SNAPSHOT_HEADER_BYTES;
const BODY_BYTES = SNAPSHOT_BODY_BYTES;
const PLAYER_BYTES = SNAPSHOT_PLAYER_BYTES;
const INPUT_HEADER_BYTES = 8;
const INPUT_RECORD_BYTES = 46;
const MAX_INPUT_COMMANDS = 4;
const LIFECYCLE_HEADER_BYTES = 11;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UNIT_INT16_SCALE = 32_767;
const VELOCITY_INT16_SCALE = 256;

const runtimeClassToTag = {
  func_physics: 1,
  func_door: 2,
  func_platform: 3,
  func_button: 4,
  player: 5,
} as const;
const runtimeTagToClass = [
  null,
  "func_physics",
  "func_door",
  "func_platform",
  "func_button",
  "player",
] as const;

export function encodeLifecycle(message: LifecycleMessage): ArrayBuffer {
  if (message.created.length > 0xffff || message.removed.length > 0xffff)
    throw new Error("lifecycle entity count exceeds uint16");
  const names = message.created.map((entity) => encoder.encode(entity.authoredId));
  const brushLists = message.created.map((entity) =>
    "brushIndex" in entity ? (entity.brushIndices ?? [entity.brushIndex]) : [],
  );
  if (names.some((name) => name.byteLength > 0xffff))
    throw new Error("lifecycle authored ID exceeds uint16");
  if (brushLists.some((indices) => indices.length > 0xffff))
    throw new Error("lifecycle brush count exceeds uint16");
  const bytes = new ArrayBuffer(
    LIFECYCLE_HEADER_BYTES +
      message.created.length * 17 +
      names.reduce((sum, name) => sum + name.byteLength, 0) +
      brushLists.reduce((sum, indices) => sum + indices.length * 4, 0) +
      message.removed.length * 8,
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
  const view =
    bytes instanceof ArrayBuffer
      ? new DataView(bytes)
      : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < LIFECYCLE_HEADER_BYTES) throw new Error("lifecycle header is truncated");
  if (view.getUint8(0) !== LIFECYCLE_TAG) throw new Error("unknown binary packet tag");
  if (view.getUint16(1, true) !== PROTOCOL_VERSION)
    throw new Error("lifecycle protocol version mismatch");
  const createdCount = view.getUint16(7, true);
  const removedCount = view.getUint16(9, true);
  const created: RuntimeEntity[] = [];
  let offset = LIFECYCLE_HEADER_BYTES;
  for (let index = 0; index < createdCount; index += 1) {
    if (offset + 17 > view.byteLength) throw new Error("lifecycle entity is truncated");
    const classname = runtimeTagToClass[view.getUint8(offset)];
    if (!classname) throw new Error("lifecycle classname tag is invalid");
    const id = {
      index: view.getUint32(offset + 1, true),
      generation: view.getUint32(offset + 5, true),
    };
    const brushIndex = view.getUint32(offset + 9, true);
    const nameLength = view.getUint16(offset + 13, true);
    const brushCount = view.getUint16(offset + 15, true);
    if (offset + 17 + nameLength + brushCount * 4 > view.byteLength)
      throw new Error("lifecycle entity is truncated");
    const authoredId = decoder.decode(
      new Uint8Array(view.buffer, view.byteOffset + offset + 17, nameLength),
    );
    offset += 17 + nameLength;
    const brushIndices = Array.from({ length: brushCount }, () => {
      const brushChildIndex = view.getUint32(offset, true);
      offset += 4;
      return brushChildIndex;
    });
    if (classname === "player") {
      if (brushIndex !== 0xffff_ffff || brushIndices.length !== 0)
        throw new Error("lifecycle player has brush data");
      created.push({ id, authoredId, classname });
    } else {
      if (brushIndex === 0xffff_ffff)
        throw new Error("lifecycle brush entity is missing its brush index");
      if (brushIndices.length === 0 || brushIndices[0] !== brushIndex)
        throw new Error("lifecycle brush list is invalid");
      created.push({
        id,
        authoredId,
        classname,
        brushIndex,
        ...(brushIndices.length > 1 ? { brushIndices } : {}),
      });
    }
  }
  const removed = [];
  for (let index = 0; index < removedCount; index += 1) {
    if (offset + 8 > view.byteLength) throw new Error("lifecycle removal is truncated");
    removed.push({
      index: view.getUint32(offset, true),
      generation: view.getUint32(offset + 4, true),
    });
    offset += 8;
  }
  if (offset !== view.byteLength) throw new Error("lifecycle packet has trailing bytes");
  return {
    type: "lifecycle",
    protocolVersion: view.getUint16(1, true),
    worldEpoch: view.getUint32(3, true),
    created,
    removed,
  };
}

export function encodeInput(command: InputCommand): ArrayBuffer {
  return encodeInputBundle([command]);
}

export function encodeInputBundle(commands: readonly InputCommand[]): ArrayBuffer {
  if (commands.length === 0 || commands.length > MAX_INPUT_COMMANDS)
    throw new Error("input bundle count is invalid");
  const first = commands[0]!;
  if (
    commands.some(
      (command) =>
        command.protocolVersion !== first.protocolVersion ||
        command.worldEpoch !== first.worldEpoch,
    )
  )
    throw new Error("input bundle commands do not share an epoch");
  const bytes = new ArrayBuffer(INPUT_HEADER_BYTES + commands.length * INPUT_RECORD_BYTES);
  const view = new DataView(bytes);
  view.setUint8(0, INPUT_TAG);
  view.setUint16(1, first.protocolVersion, true);
  view.setUint32(3, first.worldEpoch, true);
  view.setUint8(7, commands.length);
  let offset = INPUT_HEADER_BYTES;
  for (const command of commands) {
    view.setUint32(offset, command.sequence, true);
    view.setUint32(offset + 4, command.clientTick, true);
    view.setFloat32(offset + 8, command.moveX, true);
    view.setFloat32(offset + 12, command.moveZ, true);
    view.setFloat32(offset + 16, command.lookYaw, true);
    view.setFloat32(offset + 20, command.lookPitch, true);
    view.setUint16(offset + 24, command.buttons, true);
    view.setUint32(offset + 26, command.jumpCounter, true);
    view.setUint32(offset + 30, command.interactCounter, true);
    view.setUint32(offset + 34, command.interactTarget?.index ?? 0xffff_ffff, true);
    view.setUint32(offset + 38, command.interactTarget?.generation ?? 0xffff_ffff, true);
    view.setUint32(offset + 42, command.primaryCounter, true);
    offset += INPUT_RECORD_BYTES;
  }
  return bytes;
}

export function decodeInput(bytes: ArrayBuffer | ArrayBufferView): InputCommand {
  const commands = decodeInputBundle(bytes);
  if (commands.length !== 1) throw new Error("input packet contains more than one command");
  return commands[0]!;
}

export function decodeInputBundle(bytes: ArrayBuffer | ArrayBufferView): InputCommand[] {
  const view =
    bytes instanceof ArrayBuffer
      ? new DataView(bytes)
      : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < INPUT_HEADER_BYTES) throw new Error("input packet is truncated");
  if (view.getUint8(0) !== INPUT_TAG) throw new Error("unknown binary packet tag");
  if (view.getUint16(1, true) !== PROTOCOL_VERSION)
    throw new Error("input protocol version mismatch");
  const count = view.getUint8(7);
  if (
    count === 0 ||
    count > MAX_INPUT_COMMANDS ||
    view.byteLength !== INPUT_HEADER_BYTES + count * INPUT_RECORD_BYTES
  )
    throw new Error("input packet length mismatch");
  const commands: InputCommand[] = [];
  let offset = INPUT_HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    commands.push({
      type: "input",
      protocolVersion: view.getUint16(1, true),
      worldEpoch: view.getUint32(3, true),
      sequence: view.getUint32(offset, true),
      clientTick: view.getUint32(offset + 4, true),
      moveX: view.getFloat32(offset + 8, true),
      moveZ: view.getFloat32(offset + 12, true),
      lookYaw: view.getFloat32(offset + 16, true),
      lookPitch: view.getFloat32(offset + 20, true),
      buttons: view.getUint16(offset + 24, true),
      jumpCounter: view.getUint32(offset + 26, true),
      interactCounter: view.getUint32(offset + 30, true),
      interactTarget:
        view.getUint32(offset + 34, true) === 0xffff_ffff
          ? null
          : {
              index: view.getUint32(offset + 34, true),
              generation: view.getUint32(offset + 38, true),
            },
      primaryCounter: view.getUint32(offset + 42, true),
    });
    offset += INPUT_RECORD_BYTES;
  }
  return commands;
}

export function encodeSnapshot(snapshot: Snapshot): ArrayBuffer {
  const playerKeys = new Set(
    snapshot.players.map((player) => `${player.id.index}:${player.id.generation}`),
  );
  const bodies = snapshot.bodies.filter(
    (body) => !playerKeys.has(`${body.id.index}:${body.id.generation}`),
  );
  const playerBodies = new Map(
    snapshot.bodies.map((body) => [`${body.id.index}:${body.id.generation}`, body]),
  );
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
    view.setInt16(offset + 20, quantizeUnit(body.rotation.x), true);
    view.setInt16(offset + 22, quantizeUnit(body.rotation.y), true);
    view.setInt16(offset + 24, quantizeUnit(body.rotation.z), true);
    view.setInt16(offset + 26, quantizeUnit(body.rotation.w), true);
    view.setInt16(offset + 28, quantizeVelocity(body.linearVelocity?.x ?? 0), true);
    view.setInt16(offset + 30, quantizeVelocity(body.linearVelocity?.y ?? 0), true);
    view.setInt16(offset + 32, quantizeVelocity(body.linearVelocity?.z ?? 0), true);
    view.setInt16(offset + 34, quantizeVelocity(body.angularVelocity?.x ?? 0), true);
    view.setInt16(offset + 36, quantizeVelocity(body.angularVelocity?.y ?? 0), true);
    view.setInt16(offset + 38, quantizeVelocity(body.angularVelocity?.z ?? 0), true);
    view.setUint8(offset + 40, body.flags ?? 0);
    offset += BODY_BYTES;
  }
  for (const player of snapshot.players) {
    view.setUint32(offset, player.id.index, true);
    view.setUint32(offset + 4, player.id.generation, true);
    view.setFloat32(offset + 8, player.position.x, true);
    view.setFloat32(offset + 12, player.position.y, true);
    view.setFloat32(offset + 16, player.position.z, true);
    view.setInt16(offset + 20, quantizeAngle(player.yaw), true);
    view.setInt16(offset + 22, quantizeVelocity(player.verticalVelocity), true);
    view.setUint32(
      offset + 24,
      player.lastProcessedInputSequence < 0 ? 0xffff_ffff : player.lastProcessedInputSequence,
      true,
    );
    view.setUint32(offset + 28, player.lastJumpCounter, true);
    view.setUint16(offset + 32, player.stepCooldown, true);
    view.setUint8(offset + 34, Number(player.grounded) | (Number(player.crouched) << 1));
    view.setUint8(
      offset + 35,
      playerBodies.get(`${player.id.index}:${player.id.generation}`)?.flags ?? 0,
    );
    offset += PLAYER_BYTES;
  }
  return bytes;
}

export function decodeSnapshot(bytes: ArrayBuffer): Snapshot {
  if (bytes.byteLength < HEADER_BYTES) throw new Error("snapshot header is truncated");
  const view = new DataView(bytes);
  if (view.getUint8(0) !== SNAPSHOT_TAG) throw new Error("unknown binary packet tag");
  if (view.getUint16(1, true) !== PROTOCOL_VERSION)
    throw new Error("snapshot protocol version mismatch");
  const bodyCount = view.getUint16(11, true);
  const playerCount = view.getUint16(13, true);
  if (bytes.byteLength !== HEADER_BYTES + bodyCount * BODY_BYTES + playerCount * PLAYER_BYTES) {
    throw new Error("snapshot length mismatch");
  }

  const bodies: Snapshot["bodies"] = [];
  let offset = HEADER_BYTES;
  for (let index = 0; index < bodyCount; index += 1) {
    const rotation = normalizeQuaternion({
      x: view.getInt16(offset + 20, true) / UNIT_INT16_SCALE,
      y: view.getInt16(offset + 22, true) / UNIT_INT16_SCALE,
      z: view.getInt16(offset + 24, true) / UNIT_INT16_SCALE,
      w: view.getInt16(offset + 26, true) / UNIT_INT16_SCALE,
    });
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
      rotation,
      linearVelocity: {
        x: view.getInt16(offset + 28, true) / VELOCITY_INT16_SCALE,
        y: view.getInt16(offset + 30, true) / VELOCITY_INT16_SCALE,
        z: view.getInt16(offset + 32, true) / VELOCITY_INT16_SCALE,
      },
      angularVelocity: {
        x: view.getInt16(offset + 34, true) / VELOCITY_INT16_SCALE,
        y: view.getInt16(offset + 36, true) / VELOCITY_INT16_SCALE,
        z: view.getInt16(offset + 38, true) / VELOCITY_INT16_SCALE,
      },
      flags: view.getUint8(offset + 40),
    });
    offset += BODY_BYTES;
  }

  const players: Snapshot["players"] = [];
  for (let index = 0; index < playerCount; index += 1) {
    const acknowledged = view.getUint32(offset + 24, true);
    const stateFlags = view.getUint8(offset + 34);
    const player = {
      id: { index: view.getUint32(offset, true), generation: view.getUint32(offset + 4, true) },
      position: {
        x: view.getFloat32(offset + 8, true),
        y: view.getFloat32(offset + 12, true),
        z: view.getFloat32(offset + 16, true),
      },
      yaw: (view.getInt16(offset + 20, true) * Math.PI) / UNIT_INT16_SCALE,
      verticalVelocity: view.getInt16(offset + 22, true) / VELOCITY_INT16_SCALE,
      lastProcessedInputSequence: acknowledged === 0xffff_ffff ? -1 : acknowledged,
      lastJumpCounter: view.getUint32(offset + 28, true),
      stepCooldown: view.getUint16(offset + 32, true),
      grounded: (stateFlags & 1) !== 0,
      crouched: (stateFlags & 2) !== 0,
    };
    players.push(player);
    bodies.push({
      id: { ...player.id },
      position: { ...player.position },
      rotation: { x: 0, y: Math.sin(player.yaw / 2), z: 0, w: Math.cos(player.yaw / 2) },
      linearVelocity: { x: 0, y: player.verticalVelocity, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      flags: view.getUint8(offset + 35),
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

function quantizeUnit(value: number): number {
  return Math.round(Math.max(-1, Math.min(1, value)) * UNIT_INT16_SCALE);
}

function quantizeVelocity(value: number): number {
  return Math.round(
    Math.max(-UNIT_INT16_SCALE, Math.min(UNIT_INT16_SCALE, value * VELOCITY_INT16_SCALE)),
  );
}

function quantizeAngle(value: number): number {
  const normalized = Math.atan2(Math.sin(value), Math.cos(value));
  return Math.round((normalized / Math.PI) * UNIT_INT16_SCALE);
}

function normalizeQuaternion(rotation: { x: number; y: number; z: number; w: number }) {
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) || 1;
  return {
    x: rotation.x / length,
    y: rotation.y / length,
    z: rotation.z / length,
    w: rotation.w / length,
  };
}
