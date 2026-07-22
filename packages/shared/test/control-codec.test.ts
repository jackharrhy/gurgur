import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, decodeClientControl, decodeServerControl } from "../src";

describe("bounded client control union", () => {
  test("decodes every client discriminator with exact bounded fields", () => {
    const messages: unknown[] = [
      { type: "hello", protocolVersion: PROTOCOL_VERSION, mapRevision: null, worldEpoch: null, sessionToken: null, socketGeneration: 0 },
      { type: "ping", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, nonce: 2, sentAtMs: 3.5 },
      { type: "voice-ready", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, enabled: true },
      { type: "voice-block", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, peerId: "peer", blocked: true },
      { type: "voice-signal", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, toPeerId: "peer", signal: {
        description: { type: "offer", sdp: "v=0" },
        candidate: { candidate: "candidate:test", sdpMid: null, sdpMLineIndex: 0, usernameFragment: null },
      } },
    ];
    for (const message of messages) {
      expect(JSON.stringify(decodeClientControl(JSON.stringify(message)))).toBe(JSON.stringify(message));
    }
  });

  test("rejects malformed, surprising, oversized, and prototype-shaped inputs", () => {
    const invalid: string[] = [
      "null", "[]", "1", "{}", "{", JSON.stringify({ type: "unknown", protocolVersion: PROTOCOL_VERSION }),
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, mapRevision: null, worldEpoch: null, sessionToken: null, socketGeneration: -1 }),
      JSON.stringify({ type: "ping", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, nonce: 0, sentAtMs: null }),
      JSON.stringify({ type: "voice-ready", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, enabled: true, surprise: 1 }),
      JSON.stringify({ type: "voice-signal", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, toPeerId: "peer", signal: {} }),
      "x".repeat(32_769),
    ];
    let state = 0x6d2b79f5;
    for (let index = 0; index < 256; index += 1) {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      const length = 1 + ((state ^ (state >>> 14)) >>> 0) % 64;
      invalid.push(Array.from({ length }, (_, offset) => String.fromCharCode(32 + ((state + offset * 37) % 95))).join(""));
    }
    for (const source of invalid) expect(() => decodeClientControl(source)).toThrow();
  });
});

describe("bounded server control union", () => {
  test("decodes every server text discriminator with exact bounded fields", () => {
    const messages: unknown[] = [
      {
        type: "welcome", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1,
        playerId: { index: 1, generation: 2 }, mapRevision: "revision", physicsHz: 60, snapshotHz: 20,
        sessionToken: "0123456789abcdef", socketGeneration: 0, peerId: "peer",
        voiceConfig: { iceServers: [{ urls: ["stun:test"], username: "u", credential: "c" }], iceTransportPolicy: "all" },
      },
      {
        type: "world", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, mapRevision: "revision", bundleUrl: "/world.bin",
        runtimeEntities: [
          { id: { index: 1, generation: 1 }, authoredId: "box", classname: "func_physics", brushIndex: 2, brushIndices: [2, 3] },
          { id: { index: 2, generation: 1 }, authoredId: "player", classname: "player" },
        ],
      },
      { type: "pong", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, nonce: 2, sentAtMs: 3.5, serverTick: 4 },
      { type: "voice-peers", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, peers: [
        { peerId: "peer", distance: 2, relative: { x: 1, y: 0, z: -1 }, polite: true },
      ] },
      { type: "voice-signal", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, fromPeerId: "peer", signal: {
        description: { type: "answer", sdp: "v=0" },
      } },
    ];
    for (const message of messages) {
      expect(JSON.stringify(decodeServerControl(JSON.stringify(message)))).toBe(JSON.stringify(message));
    }
  });

  test("rejects malformed server control packets before they reach browser state", () => {
    const invalid = [
      "null", "[]", "{", "x".repeat(32_769),
      JSON.stringify({ type: "world", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, mapRevision: "r", bundleUrl: "/", runtimeEntities: [
        { id: { index: -1, generation: 0 }, authoredId: "bad", classname: "player" },
      ] }),
      JSON.stringify({ type: "voice-peers", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, peers: [
        { peerId: "p", distance: -1, relative: { x: 0, y: 0, z: 0 }, polite: true },
      ] }),
      JSON.stringify({ type: "pong", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, nonce: 0, sentAtMs: 0, serverTick: 0, surprise: true }),
    ];
    for (const source of invalid) expect(() => decodeServerControl(source)).toThrow();
  });
});
