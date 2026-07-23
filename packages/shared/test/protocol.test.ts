import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  decodeInput,
  decodeInputBundle,
  decodeLifecycle,
  decodeSnapshot,
  encodeInput,
  encodeInputBundle,
  encodeLifecycle,
  encodeSnapshot,
} from "../src";

describe("snapshot codec", () => {
  test("round-trips an authoritative body snapshot", () => {
    const snapshot = {
      worldEpoch: 4,
      serverTick: 120,
      bodies: [
        {
          id: { index: 7, generation: 2 },
          position: { x: 1.25, y: -2.5, z: 3.75 },
          rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
          linearVelocity: { x: 4, y: -1, z: 2 },
          angularVelocity: { x: 0.1, y: 0.2, z: 0.3 },
        },
      ],
      players: [
        {
          id: { index: 9, generation: 3 },
          position: { x: -1, y: 2, z: 4 },
          yaw: 0.4,
          verticalVelocity: -2.25,
          grounded: false,
          lastProcessedInputSequence: 18,
          lastJumpCounter: 2,
          stepCooldown: 4,
          crouched: true,
        },
      ],
    };
    const decoded = decodeSnapshot(encodeSnapshot(snapshot));
    expect(decoded.worldEpoch).toBe(snapshot.worldEpoch);
    expect(decoded.serverTick).toBe(snapshot.serverTick);
    const expectedBody = snapshot.bodies[0]!;
    expect(decoded.bodies[0]?.id).toEqual(expectedBody.id);
    expect(decoded.bodies[0]?.position).toEqual(expectedBody.position);
    expect(decoded.bodies[0]?.rotation.y).toBeCloseTo(expectedBody.rotation.y);
    expect(decoded.bodies[0]?.linearVelocity).toEqual(expectedBody.linearVelocity);
    expect(decoded.bodies[0]?.angularVelocity?.z).toBeCloseTo(expectedBody.angularVelocity.z);
    expect(decoded.players[0]?.id).toEqual(snapshot.players[0]!.id);
    expect(decoded.players[0]?.position).toEqual(snapshot.players[0]!.position);
    expect(decoded.players[0]?.yaw).toBeCloseTo(snapshot.players[0]!.yaw);
    expect(decoded.players[0]?.verticalVelocity).toBeCloseTo(snapshot.players[0]!.verticalVelocity);
    expect(decoded.players[0]?.lastProcessedInputSequence).toBe(18);
    expect(decoded.players[0]?.stepCooldown).toBe(4);
    expect(decoded.players[0]?.crouched).toBe(true);
  });

  test("rejects truncated packets", () => {
    expect(() => decodeSnapshot(new ArrayBuffer(2))).toThrow("truncated");
  });

  test("serializes a player once and reconstructs its body sample on decode", () => {
    const id = { index: 0x8000_0001, generation: 2 };
    const snapshot = {
      worldEpoch: 1,
      serverTick: 3,
      bodies: [
        {
          id,
          position: { x: 1, y: 2, z: 3 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          linearVelocity: { x: 0, y: 4, z: 0 },
          angularVelocity: { x: 0, y: 0, z: 0 },
          flags: 2,
        },
      ],
      players: [
        {
          id,
          position: { x: 1, y: 2, z: 3 },
          yaw: 0,
          verticalVelocity: 4,
          grounded: false,
          lastProcessedInputSequence: 8,
          lastJumpCounter: 1,
          stepCooldown: 0,
          crouched: false,
        },
      ],
    };
    const encoded = encodeSnapshot(snapshot);
    expect(encoded.byteLength).toBe(15 + 36);
    const decoded = decodeSnapshot(encoded);
    expect(decoded.players).toHaveLength(1);
    expect(decoded.bodies).toHaveLength(1);
    expect(decoded.bodies[0]).toMatchObject({ id, position: { x: 1, y: 2, z: 3 }, flags: 2 });
  });
});

describe("input codec", () => {
  test("round-trips fixed-rate player intent", () => {
    const command = {
      type: "input" as const,
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: 4,
      sequence: 19,
      clientTick: 33,
      moveX: -0.5,
      moveZ: 1,
      lookYaw: 1.25,
      lookPitch: -0.2,
      buttons: 3,
      jumpCounter: 2,
      interactCounter: 1,
      interactTarget: { index: 88, generation: 4 },
      primaryCounter: 7,
    };
    const decoded = decodeInput(encodeInput(command));
    expect({ ...decoded, lookPitch: command.lookPitch }).toEqual(command);
    expect(decoded.lookPitch).toBeCloseTo(command.lookPitch);
  });

  test("rejects malformed fixed-rate input", () => {
    expect(() => decodeInput(new ArrayBuffer(12))).toThrow();
  });

  test("bundles the newest intent with redundant predecessors", () => {
    const commands = [0, 1, 2].map((sequence) => ({
      type: "input" as const,
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: 7,
      sequence,
      clientTick: sequence + 10,
      moveX: sequence / 2,
      moveZ: 0,
      lookYaw: 0,
      lookPitch: 0,
      buttons: 0,
      jumpCounter: sequence,
      interactCounter: 0,
      interactTarget: null,
      primaryCounter: 0,
    }));
    expect(decodeInputBundle(encodeInputBundle(commands))).toEqual(commands);
    expect(() => decodeInput(encodeInputBundle(commands))).toThrow("more than one");
  });

  test("round-trips an absent interaction target", () => {
    const command = {
      type: "input" as const,
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: 1,
      sequence: 0,
      clientTick: 0,
      moveX: 0,
      moveZ: 0,
      lookYaw: 0,
      lookPitch: 0,
      buttons: 0,
      jumpCounter: 0,
      interactCounter: 0,
      interactTarget: null,
      primaryCounter: 0,
    };
    expect(decodeInput(encodeInput(command)).interactTarget).toBeNull();
  });
});

describe("lifecycle codec", () => {
  test("round-trips created brush/player identities and removals", () => {
    const lifecycle = {
      type: "lifecycle" as const,
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: 7,
      created: [
        {
          id: { index: 1, generation: 2 },
          authoredId: "door.å",
          classname: "func_door" as const,
          brushIndex: 9,
          brushIndices: [9, 10, 11],
        },
        {
          id: { index: 0x8000_0000, generation: 4 },
          authoredId: "player.1",
          classname: "player" as const,
        },
      ],
      removed: [{ index: 3, generation: 8 }],
    };
    expect(decodeLifecycle(encodeLifecycle(lifecycle))).toEqual(lifecycle);
  });

  test("rejects truncated lifecycle data", () => {
    const lifecycle = {
      type: "lifecycle" as const,
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: 1,
      created: [
        { id: { index: 1, generation: 1 }, authoredId: "player.1", classname: "player" as const },
      ],
      removed: [],
    };
    const encoded = encodeLifecycle(lifecycle);
    expect(() => decodeLifecycle(encoded.slice(0, encoded.byteLength - 1))).toThrow("truncated");
  });
});
