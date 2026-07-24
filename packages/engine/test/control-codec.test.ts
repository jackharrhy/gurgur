import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, decodeClientControl, decodeServerControl } from "../src";

describe("bounded client control union", () => {
  test("decodes every client discriminator with exact bounded fields", () => {
    const messages: unknown[] = [
      {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        mapRevision: null,
        worldEpoch: null,
        sessionToken: null,
        socketGeneration: 0,
      },
      { type: "ping", protocolVersion: PROTOCOL_VERSION, worldEpoch: 1, nonce: 2, sentAtMs: 3.5 },
      {
        type: "rtc-answer",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        description: { type: "answer", sdp: "v=0\r\n" },
      },
    ];
    for (const message of messages) {
      expect(JSON.stringify(decodeClientControl(JSON.stringify(message)))).toBe(
        JSON.stringify(message),
      );
    }
  });

  test("rejects malformed, surprising, oversized, and prototype-shaped inputs", () => {
    const invalid: string[] = [
      "null",
      "[]",
      "1",
      "{}",
      "{",
      JSON.stringify({ type: "unknown", protocolVersion: PROTOCOL_VERSION }),
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        mapRevision: null,
        worldEpoch: null,
        sessionToken: null,
        socketGeneration: -1,
      }),
      JSON.stringify({
        type: "ping",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        nonce: 0,
        sentAtMs: null,
      }),
      JSON.stringify({ type: "not-supported", protocolVersion: PROTOCOL_VERSION }),
      "x".repeat(32_769),
    ];
    let state = 0x6d2b79f5;
    for (let index = 0; index < 256; index += 1) {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      const length = 1 + (((state ^ (state >>> 14)) >>> 0) % 64);
      invalid.push(
        Array.from({ length }, (_, offset) =>
          String.fromCharCode(32 + ((state + offset * 37) % 95)),
        ).join(""),
      );
    }
    for (const source of invalid) expect(() => decodeClientControl(source)).toThrow();
  });
});

describe("bounded server control union", () => {
  test("decodes every server text discriminator with exact bounded fields", () => {
    const messages: unknown[] = [
      {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        playerId: { index: 1, generation: 2 },
        mapRevision: "revision",
        physicsHz: 60,
        snapshotHz: 30,
        sessionToken: "0123456789abcdef",
        socketGeneration: 0,
      },
      {
        type: "world",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        mapRevision: "revision",
        bundleUrl: "/world.bin",
        runtimeEntities: [
          {
            id: { index: 1, generation: 1 },
            kind: "world-entity",
            entityIndex: 2,
          },
          { id: { index: 2, generation: 1 }, kind: "player" },
        ],
      },
      {
        type: "pong",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        nonce: 2,
        sentAtMs: 3.5,
        serverTick: 4,
      },
      {
        type: "rtc-offer",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        description: { type: "offer", sdp: "v=0\r\n" },
        iceServers: [{ urls: "turn:relay.example", username: "u", credential: "p" }],
      },
    ];
    for (const message of messages) {
      expect(JSON.stringify(decodeServerControl(JSON.stringify(message)))).toBe(
        JSON.stringify(message),
      );
    }
  });

  test("rejects malformed server control packets before they reach browser state", () => {
    const invalid = [
      "null",
      "[]",
      "{",
      "x".repeat(32_769),
      JSON.stringify({
        type: "world",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        mapRevision: "r",
        bundleUrl: "/",
        runtimeEntities: [{ id: { index: -1, generation: 0 }, kind: "player", unexpected: "bad" }],
      }),
      JSON.stringify({ type: "not-supported", protocolVersion: PROTOCOL_VERSION }),
      JSON.stringify({
        type: "pong",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        nonce: 0,
        sentAtMs: 0,
        serverTick: 0,
        surprise: true,
      }),
    ];
    for (const source of invalid) expect(() => decodeServerControl(source)).toThrow();
  });
});
