import { describe, expect, test } from "bun:test";
import {
  GURGUR_TRACE_FORMAT,
  GURGUR_TRACE_FORMAT_VERSION,
  validateGurgurNetworkTrace,
  type GurgurClientTrace,
  type InputCommand,
} from "@gurgur/engine";
import { NetworkTraceCapture, TraceConflictError, TraceNotFoundError } from "../src/network-trace";

const playerId = { index: 0x8000_0000, generation: 1 };

describe("server network trace capture", () => {
  test("joins bounded server streams with the supplied client recording", () => {
    const capture = new NetworkTraceCapture();
    const started = capture.start(
      { playerId, worldEpoch: 4, mapRevision: "fixture" },
      100,
      "working-tree",
    );
    expect(() =>
      capture.start({ playerId, worldEpoch: 4, mapRevision: "fixture" }, 100, "working-tree"),
    ).toThrow(TraceConflictError);
    expect(
      capture.recordFrame({
        worldEpoch: 4,
        serverTick: 101,
        bodies: [],
        players: [
          {
            id: playerId,
            position: { x: 0, y: 1, z: 0 },
            yaw: 0,
            verticalVelocity: 0,
            grounded: true,
            lastProcessedInputSequence: 1,
            lastJumpCounter: 0,
            stepCooldown: 0,
            crouched: false,
            grabTarget: null,
          },
        ],
      }),
    ).toBeTrue();
    const input = command(1);
    capture.recordInput(playerId, 100, "webrtc", input, true);
    capture.recordInput(playerId, 100, "webrtc", input, true);
    capture.recordOutbound(playerId, {
      serverTick: 100,
      status: "dropped-backpressure",
      bufferedAmount: 2_400,
      packetBytes: null,
      selected: null,
      wire: null,
    });

    const trace = capture.stop(started.captureId, emptyClientTrace(started.captureId));
    expect(trace.format).toBe(GURGUR_TRACE_FORMAT);
    expect(trace.formatVersion).toBe(GURGUR_TRACE_FORMAT_VERSION);
    expect(trace.capture.stopReason).toBe("user");
    expect(trace.server.frames).toHaveLength(1);
    expect(trace.server.inputs.map((record) => record.firstReceipt)).toEqual([true, false]);
    expect(trace.server.outboundSnapshots[0]?.status).toBe("dropped-backpressure");
    expect(trace.analysis.prediction.rawCorrectionMetres.samples).toBe(0);
    expect(validateGurgurNetworkTrace(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
    expect(() => capture.stop(started.captureId, emptyClientTrace(started.captureId))).toThrow(
      TraceNotFoundError,
    );
  });

  test("freezes a recording when the authoritative world changes", () => {
    const capture = new NetworkTraceCapture();
    const started = capture.start(
      { playerId, worldEpoch: 4, mapRevision: "fixture" },
      100,
      "working-tree",
    );
    expect(
      capture.recordFrame({
        worldEpoch: 5,
        serverTick: 0,
        bodies: [],
        players: [],
      }),
    ).toBeFalse();
    const trace = capture.stop(started.captureId, emptyClientTrace(started.captureId));
    expect(trace.capture.stopReason).toBe("world-changed");
    expect(trace.server.truncatedStreams).toContain("frames");
  });
});

function emptyClientTrace(captureId: string): GurgurClientTrace {
  return {
    format: GURGUR_TRACE_FORMAT,
    formatVersion: GURGUR_TRACE_FORMAT_VERSION,
    captureId,
    clientStartedAt: "2026-01-01T00:00:00.000Z",
    clientEndedAt: "2026-01-01T00:00:01.000Z",
    clientTimeOriginUnixMs: 1_000,
    pageUrl: "http://localhost/?debug",
    userAgent: "test",
    inputs: [],
    snapshots: [],
    prediction: [],
    presentation: [],
    clocks: [],
    network: [],
    markers: [],
    truncatedStreams: [],
  };
}

function command(sequence: number): InputCommand {
  return {
    type: "input",
    protocolVersion: 1,
    worldEpoch: 4,
    sequence,
    clientTick: sequence,
    moveX: 1,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    jumpCounter: 0,
    interactCounter: 0,
    interactTarget: null,
    primaryCounter: 0,
  };
}
