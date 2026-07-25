import { describe, expect, test } from "bun:test";
import {
  GURGUR_TRACE_FORMAT,
  GURGUR_TRACE_FORMAT_VERSION,
  PROTOCOL_VERSION,
  analyzeGurgurTrace,
  validateGurgurClientTrace,
  validateGurgurTraceStartRequest,
  type BodySnapshot,
  type GurgurClientTrace,
  type GurgurNetworkTrace,
  type PlayerStateSnapshot,
  type TraceServerFrame,
} from "../src";

const playerId = { index: 0x8000_0000, generation: 1 };
const propId = { index: 3, generation: 2 };
const rotation = { x: 0, y: 0, z: 0, w: 1 };

describe("gurgur network trace format", () => {
  test("publishes a parseable v1 JSON Schema with resolvable local definitions", async () => {
    const schema = (await Bun.file("docs/gurgur-trace-v1.schema.json").json()) as {
      $schema: string;
      properties: { format: { const: string }; formatVersion: { const: number } };
      $defs: Record<string, unknown>;
    };
    expect(schema.$schema).toContain("2020-12");
    expect(schema.properties.format.const).toBe(GURGUR_TRACE_FORMAT);
    expect(schema.properties.formatVersion.const).toBe(GURGUR_TRACE_FORMAT_VERSION);
    const refs = JSON.stringify(schema).matchAll(/"#\/\$defs\/([^"]+)"/g);
    for (const match of refs) expect(schema.$defs[match[1]!]).toBeDefined();
  });

  test("analyzes wire, delivery, prediction, presentation, and timing separately", () => {
    const selectedBody = body(propId, 1.0004);
    const wireBody = body(propId, 1);
    const wireSnapshot = snapshot(1, wireBody);
    const frames: TraceServerFrame[] = [serverFrame(1, 1), serverFrame(2, 2)];
    const server: GurgurNetworkTrace["server"] = {
      startTick: 0,
      endTick: 2,
      frames,
      inputs: [],
      outboundSnapshots: [
        {
          serverTick: 1,
          serverAtMs: 20,
          status: "sent",
          bufferedAmount: 0,
          packetBytes: 100,
          selected: snapshot(1, selectedBody),
          wire: wireSnapshot,
        },
      ],
      truncatedStreams: [],
    };
    const client = emptyClientTrace("capture");
    client.inputs.push({
      clientAtMs: 100,
      command: {
        type: "input",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: 1,
        sequence: 10,
        clientTick: 20,
        moveX: 0,
        moveZ: 1,
        lookYaw: 0,
        lookPitch: 0,
        buttons: 0,
        jumpCounter: 0,
        interactCounter: 0,
        interactTarget: null,
        primaryCounter: 0,
      },
    });
    client.snapshots.push({
      clientReceivedAtMs: 180,
      clientProcessedAtMs: 185,
      latestInFrame: true,
      estimatedServerTickAtReceipt: 2,
      snapshot: wireSnapshot,
    });
    client.prediction.push({
      clientAtMs: 180,
      event: {
        kind: "reconciliation",
        workerAtMs: 80,
        workerTimeOriginUnixMs: 1_000,
        serverTick: 1,
        reconcilePlayer: true,
        outcome: "replayed",
        authority: player(10),
        before: null,
        after: null,
        acknowledgedInputSequence: 10,
        pendingInputCountBefore: 3,
        pendingInputCountAfter: 2,
        replayedInputSequences: [11, 12],
        rawErrorMetres: 0.2,
        visibleCorrectionMetres: 0.2,
        proxies: [],
      },
    });
    client.presentation.push({
      clientAtMs: 190,
      latestSnapshotTick: 2,
      estimatedServerTick: 3,
      interpolationDelayTicks: 1.5,
      presentationTargetTick: 1.5,
      extrapolatedBodyIds: [],
      bodies: [
        {
          body: body(propId, 1.6),
          source: "interpolated",
          comparisonServerTick: 1.5,
        },
      ],
    });

    const analysis = analyzeGurgurTrace(server, client, playerId);
    expect(analysis.wireQuantization.positionMetres.max).toBeCloseTo(0.0004, 6);
    expect(analysis.clientDelivery.positionMetres.max).toBe(0);
    expect(analysis.clientDelivery.bodySetMismatches).toBe(0);
    expect(analysis.prediction.rawCorrectionMetres.max).toBe(0.2);
    expect(analysis.presentation.bySource.interpolated?.positionMetres.max).toBeCloseTo(0.1);
    expect(analysis.timing.inputAcknowledgementMs.max).toBe(80);
    expect(analysis.timing.replayedInputs.max).toBe(2);
    expect(analysis.timing.snapshotAgeMs.max).toBeCloseTo(1_000 / 60);
  });

  test("validates the versioned client envelope and rejects unknown structure", () => {
    expect(validateGurgurClientTrace(emptyClientTrace("capture")).captureId).toBe("capture");
    expect(() =>
      validateGurgurClientTrace({ ...emptyClientTrace("capture"), unexpected: true }),
    ).toThrow("fields are invalid");
    expect(() =>
      validateGurgurClientTrace({
        ...emptyClientTrace("capture"),
        clientTimeOriginUnixMs: Number.NaN,
      }),
    ).toThrow("non-finite");
    expect(
      validateGurgurTraceStartRequest({
        playerId,
        worldEpoch: 1,
        mapRevision: "map",
      }),
    ).toEqual({ playerId, worldEpoch: 1, mapRevision: "map" });
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

function body(id: BodySnapshot["id"], x: number): BodySnapshot {
  return {
    id,
    position: { x, y: 0, z: 0 },
    rotation,
    linearVelocity: { x: 1, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
}

function player(lastProcessedInputSequence: number): PlayerStateSnapshot {
  return {
    id: playerId,
    position: { x: 0, y: 1, z: 0 },
    yaw: 0,
    verticalVelocity: 0,
    grounded: true,
    lastProcessedInputSequence,
    lastJumpCounter: 0,
    stepCooldown: 0,
    crouched: false,
  };
}

function snapshot(serverTick: number, prop: BodySnapshot) {
  return {
    worldEpoch: 1,
    serverTick,
    bodies: [prop, body(playerId, 0)],
    players: [player(10)],
  };
}

function serverFrame(serverTick: number, propX: number): TraceServerFrame {
  return {
    worldEpoch: 1,
    serverTick,
    serverAtMs: (serverTick * 1_000) / 60,
    bodies: [
      {
        ...body(propId, propX),
        linearVelocity: { x: 1, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        awake: true,
      },
    ],
    players: [
      {
        ...player(10),
        grabTarget: null,
      },
    ],
  };
}
