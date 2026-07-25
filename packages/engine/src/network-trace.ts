import { PHYSICS_HZ, SNAPSHOT_HZ } from "./config";
import type {
  BodySnapshot,
  BodyState,
  InputCommand,
  PlayerStateSnapshot,
  Quat,
  RuntimeId,
  Snapshot,
  Vec3,
} from "./types";

export const GURGUR_TRACE_FORMAT = "gurgur-network-trace";
export const GURGUR_TRACE_FORMAT_VERSION = 1;
export const GURGUR_TRACE_ANALYSIS_VERSION = 1;
export const GURGUR_TRACE_MAX_DURATION_MS = 15_000;
export const GURGUR_TRACE_MAX_CLIENT_RECORDS = 100_000;
export const GURGUR_TRACE_MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

export type GurgurTraceCapabilities = {
  enabled: true;
  format: typeof GURGUR_TRACE_FORMAT;
  formatVersion: typeof GURGUR_TRACE_FORMAT_VERSION;
  maxDurationMs: number;
  maxClientRecords: number;
};

export type GurgurTraceStartRequest = {
  playerId: RuntimeId;
  worldEpoch: number;
  mapRevision: string;
};

export type GurgurTraceStartResponse = {
  captureId: string;
  serverTick: number;
  serverStartedAt: string;
  maxDurationMs: number;
};

export type TraceControllerState = {
  position: Vec3;
  yaw: number;
  verticalVelocity: number;
  grounded: boolean;
  lastJumpCounter: number;
  stepCooldown: number;
  crouched: boolean;
};

export type TraceServerPlayerState = TraceControllerState & {
  id: RuntimeId;
  lastProcessedInputSequence: number;
  grabTarget: RuntimeId | null;
};

export type TraceServerFrame = {
  worldEpoch: number;
  serverTick: number;
  serverAtMs: number;
  bodies: BodyState[];
  players: TraceServerPlayerState[];
};

export type TraceServerInput = {
  serverTickAtReceipt: number;
  serverAtMs: number;
  transport: "websocket" | "webrtc";
  command: InputCommand;
  accepted: boolean;
  firstReceipt: boolean;
};

export type TraceOutboundSnapshot = {
  serverTick: number;
  serverAtMs: number;
  status: "sent" | "dropped-backpressure" | "transport-unavailable" | "send-failed";
  bufferedAmount: number;
  packetBytes: number | null;
  selected: Snapshot | null;
  wire: Snapshot | null;
};

export type TracePredictionProxy = {
  id: RuntimeId;
  authorityTick: number;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  extrapolationTicksRemaining: number;
  freshnessTicksRemaining: number;
  collisionEnabled: boolean;
  holdWhenStale: boolean;
  contactPresentation: boolean;
};

export type TracePredictionInputEvent = {
  kind: "input";
  workerAtMs: number;
  workerTimeOriginUnixMs: number;
  sequence: number;
  clientTick: number;
  outcome:
    | "predicted"
    | "intent-only"
    | "queued-without-world"
    | "rejected-epoch"
    | "implausible-reset";
  before: TraceControllerState | null;
  after: TraceControllerState | null;
  pendingInputCount: number;
  visibleCorrectionMetres: number;
};

export type TraceReconciliationOutcome =
  | "replayed"
  | "stalled-reset"
  | "teleport-reset"
  | "implausible-reset"
  | "proxy-only"
  | "stale-snapshot"
  | "missing-player"
  | "pending-world"
  | "wrong-epoch";

export type TracePredictionReconciliationEvent = {
  kind: "reconciliation";
  workerAtMs: number;
  workerTimeOriginUnixMs: number;
  serverTick: number;
  reconcilePlayer: boolean;
  outcome: TraceReconciliationOutcome;
  authority: PlayerStateSnapshot | null;
  before: TraceControllerState | null;
  after: TraceControllerState | null;
  acknowledgedInputSequence: number | null;
  pendingInputCountBefore: number;
  pendingInputCountAfter: number;
  replayedInputSequences: number[];
  rawErrorMetres: number | null;
  visibleCorrectionMetres: number;
  proxies: TracePredictionProxy[];
};

export type TracePredictionEvent = TracePredictionInputEvent | TracePredictionReconciliationEvent;

export type TraceClientPredictionRecord = {
  clientAtMs: number;
  event: TracePredictionEvent;
};

export type TraceClientInput = {
  clientAtMs: number;
  command: InputCommand;
};

export type TraceClientSnapshot = {
  clientReceivedAtMs: number;
  clientProcessedAtMs: number | null;
  latestInFrame: boolean | null;
  estimatedServerTickAtReceipt: number;
  snapshot: Snapshot;
};

export type TracePresentedBodySource =
  | "interpolated"
  | "current-contact"
  | "predicted-proxy"
  | "predicted-local"
  | "current-local-fallback";

export type TracePresentedBody = {
  body: BodySnapshot;
  source: TracePresentedBodySource;
  comparisonServerTick: number;
};

export type TracePresentationFrame = {
  clientAtMs: number;
  latestSnapshotTick: number;
  estimatedServerTick: number;
  interpolationDelayTicks: number;
  presentationTargetTick: number;
  extrapolatedBodyIds: RuntimeId[];
  bodies: TracePresentedBody[];
};

export type TraceClockSample = {
  clientAtMs: number;
  source: "snapshot" | "pong";
  serverTick: number;
  oneWayDelayMs: number;
};

export type TraceNetworkSample = {
  clientAtMs: number;
  rttMs: number;
  jitterMs: number;
};

export type TraceClientMarker = {
  clientAtMs: number;
  kind: "connection" | "transport" | "world" | "lifecycle" | "visibility";
  value: string;
  serverTick?: number;
};

export type GurgurClientTrace = {
  format: typeof GURGUR_TRACE_FORMAT;
  formatVersion: typeof GURGUR_TRACE_FORMAT_VERSION;
  captureId: string;
  clientStartedAt: string;
  clientEndedAt: string;
  clientTimeOriginUnixMs: number;
  pageUrl: string;
  userAgent: string;
  inputs: TraceClientInput[];
  snapshots: TraceClientSnapshot[];
  prediction: TraceClientPredictionRecord[];
  presentation: TracePresentationFrame[];
  clocks: TraceClockSample[];
  network: TraceNetworkSample[];
  markers: TraceClientMarker[];
  truncatedStreams: string[];
};

export type GurgurTraceStopRequest = {
  captureId: string;
  client: GurgurClientTrace;
};

export type TraceMetricSummary = {
  samples: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
};

export type TracePoseErrorSummary = {
  positionMetres: TraceMetricSummary;
  rotationDegrees: TraceMetricSummary;
};

export type TraceStateErrorSummary = TracePoseErrorSummary & {
  linearVelocityMetresPerSecond: TraceMetricSummary;
  angularVelocityRadiansPerSecond: TraceMetricSummary;
};

export type TraceWorstCorrection = {
  serverTick: number;
  clientAtMs: number;
  rawErrorMetres: number;
  outcome: TraceReconciliationOutcome;
  acknowledgedInputSequence: number | null;
  replayedInputCount: number;
};

export type TraceWorstPresentation = {
  serverTick: number;
  clientAtMs: number;
  id: RuntimeId;
  source: TracePresentedBodySource;
  positionErrorMetres: number;
  rotationErrorDegrees: number;
};

export type GurgurTraceAnalysis = {
  analysisVersion: typeof GURGUR_TRACE_ANALYSIS_VERSION;
  wireQuantization: TraceStateErrorSummary & {
    selectedRecords: number;
    wireRecords: number;
    missingWireRecords: number;
  };
  clientDelivery: TraceStateErrorSummary & {
    outboundSent: number;
    clientReceived: number;
    matchedSnapshots: number;
    unmatchedClientSnapshots: number;
    bodySetMismatches: number;
    droppedBackpressure: number;
    transportUnavailable: number;
    sendFailed: number;
  };
  prediction: {
    rawCorrectionMetres: TraceMetricSummary;
    proxyAuthorityAgeTicks: TraceMetricSummary;
    proxyFreshnessTicksRemaining: TraceMetricSummary;
    disabledContactProxySamples: number;
    reconciliationOutcomes: Record<string, number>;
    worstCorrections: TraceWorstCorrection[];
  };
  presentation: {
    bySource: Partial<Record<TracePresentedBodySource, TracePoseErrorSummary>>;
    missingAuthoritySamples: number;
    worst: TraceWorstPresentation[];
  };
  timing: {
    inputAcknowledgementMs: TraceMetricSummary;
    snapshotAgeMs: TraceMetricSummary;
    replayedInputs: TraceMetricSummary;
  };
  notes: string[];
};

export type GurgurNetworkTrace = {
  format: typeof GURGUR_TRACE_FORMAT;
  formatVersion: typeof GURGUR_TRACE_FORMAT_VERSION;
  generatedAt: string;
  capture: {
    id: string;
    serverStartedAt: string;
    serverEndedAt: string;
    stopReason: "user" | "duration-limit" | "record-limit" | "world-changed";
    limits: {
      maxDurationMs: number;
      maxClientRecords: number;
      maxServerFrames: number;
      maxServerBodyRecords: number;
    };
  };
  session: {
    buildRevision: string;
    mapRevision: string;
    worldEpoch: number;
    playerId: RuntimeId;
    physicsHz: number;
    snapshotHz: number;
  };
  coordinateSystem: {
    linearUnits: "metres";
    angularUnits: "radians";
    handedness: "right";
    upAxis: "+Y";
    forwardAtZeroYaw: "-Z";
    timestamps: "milliseconds";
  };
  server: {
    startTick: number;
    endTick: number;
    frames: TraceServerFrame[];
    inputs: TraceServerInput[];
    outboundSnapshots: TraceOutboundSnapshot[];
    truncatedStreams: string[];
  };
  client: GurgurClientTrace;
  analysis: GurgurTraceAnalysis;
};

export function gurgurTraceCapabilities(): GurgurTraceCapabilities {
  return {
    enabled: true,
    format: GURGUR_TRACE_FORMAT,
    formatVersion: GURGUR_TRACE_FORMAT_VERSION,
    maxDurationMs: GURGUR_TRACE_MAX_DURATION_MS,
    maxClientRecords: GURGUR_TRACE_MAX_CLIENT_RECORDS,
  };
}

export function validateGurgurTraceStartRequest(value: unknown): GurgurTraceStartRequest {
  const record = object(value, "trace start request");
  const playerId = runtimeId(record.playerId, "playerId");
  const worldEpoch = safeInteger(record.worldEpoch, "worldEpoch", 0);
  const mapRevision = boundedString(record.mapRevision, "mapRevision", 1, 128);
  exactKeys(record, ["playerId", "worldEpoch", "mapRevision"], "trace start request");
  return { playerId, worldEpoch, mapRevision };
}

export function validateGurgurTraceStopRequest(value: unknown): GurgurTraceStopRequest {
  const record = object(value, "trace stop request");
  const captureId = boundedString(record.captureId, "captureId", 1, 128);
  const client = validateGurgurClientTrace(record.client);
  exactKeys(record, ["captureId", "client"], "trace stop request");
  if (client.captureId !== captureId) throw new Error("client captureId does not match request");
  return { captureId, client };
}

export function validateGurgurClientTrace(value: unknown): GurgurClientTrace {
  validateJsonTree(value, 0);
  const record = object(value, "client trace");
  if (record.format !== GURGUR_TRACE_FORMAT) throw new Error("client trace format is invalid");
  if (record.formatVersion !== GURGUR_TRACE_FORMAT_VERSION)
    throw new Error("client trace formatVersion is unsupported");
  const captureId = boundedString(record.captureId, "captureId", 1, 128);
  const clientStartedAt = isoDate(record.clientStartedAt, "clientStartedAt");
  const clientEndedAt = isoDate(record.clientEndedAt, "clientEndedAt");
  const clientTimeOriginUnixMs = finiteNumber(
    record.clientTimeOriginUnixMs,
    "clientTimeOriginUnixMs",
  );
  const pageUrl = boundedString(record.pageUrl, "pageUrl", 1, 2_048);
  const userAgent = boundedString(record.userAgent, "userAgent", 0, 1_024);
  const inputs = boundedArray<TraceClientInput>(record.inputs, "inputs");
  const snapshots = boundedArray<TraceClientSnapshot>(record.snapshots, "snapshots");
  const prediction = boundedArray<TraceClientPredictionRecord>(record.prediction, "prediction");
  const presentation = boundedArray<TracePresentationFrame>(record.presentation, "presentation");
  const clocks = boundedArray<TraceClockSample>(record.clocks, "clocks");
  const network = boundedArray<TraceNetworkSample>(record.network, "network");
  const markers = boundedArray<TraceClientMarker>(record.markers, "markers");
  const truncatedStreams = boundedArray<string>(record.truncatedStreams, "truncatedStreams", 32);
  const totalRecords =
    inputs.length +
    snapshots.length +
    prediction.length +
    presentation.length +
    clocks.length +
    network.length +
    markers.length;
  if (totalRecords > GURGUR_TRACE_MAX_CLIENT_RECORDS)
    throw new Error("client trace exceeds record limit");
  exactKeys(
    record,
    [
      "format",
      "formatVersion",
      "captureId",
      "clientStartedAt",
      "clientEndedAt",
      "clientTimeOriginUnixMs",
      "pageUrl",
      "userAgent",
      "inputs",
      "snapshots",
      "prediction",
      "presentation",
      "clocks",
      "network",
      "markers",
      "truncatedStreams",
    ],
    "client trace",
  );
  return {
    format: GURGUR_TRACE_FORMAT,
    formatVersion: GURGUR_TRACE_FORMAT_VERSION,
    captureId,
    clientStartedAt,
    clientEndedAt,
    clientTimeOriginUnixMs,
    pageUrl,
    userAgent,
    inputs,
    snapshots,
    prediction,
    presentation,
    clocks,
    network,
    markers,
    truncatedStreams,
  };
}

export function validateGurgurNetworkTrace(value: unknown): GurgurNetworkTrace {
  validateJsonTree(value, 0);
  const record = object(value, "network trace");
  if (record.format !== GURGUR_TRACE_FORMAT) throw new Error("network trace format is invalid");
  if (record.formatVersion !== GURGUR_TRACE_FORMAT_VERSION)
    throw new Error("network trace formatVersion is unsupported");
  isoDate(record.generatedAt, "generatedAt");
  const capture = object(record.capture, "capture");
  const captureId = boundedString(capture.id, "capture.id", 1, 128);
  isoDate(capture.serverStartedAt, "capture.serverStartedAt");
  isoDate(capture.serverEndedAt, "capture.serverEndedAt");
  if (
    !["user", "duration-limit", "record-limit", "world-changed"].includes(
      String(capture.stopReason),
    )
  )
    throw new Error("capture.stopReason is invalid");
  object(capture.limits, "capture.limits");
  const session = object(record.session, "session");
  boundedString(session.buildRevision, "session.buildRevision", 1, 256);
  boundedString(session.mapRevision, "session.mapRevision", 1, 128);
  safeInteger(session.worldEpoch, "session.worldEpoch", 0);
  runtimeId(session.playerId, "session.playerId");
  finiteNumber(session.physicsHz, "session.physicsHz");
  finiteNumber(session.snapshotHz, "session.snapshotHz");
  object(record.coordinateSystem, "coordinateSystem");
  const server = object(record.server, "server");
  safeInteger(server.startTick, "server.startTick", 0);
  safeInteger(server.endTick, "server.endTick", 0);
  boundedArray(server.frames, "server.frames");
  boundedArray(server.inputs, "server.inputs");
  boundedArray(server.outboundSnapshots, "server.outboundSnapshots");
  boundedArray(server.truncatedStreams, "server.truncatedStreams", 32);
  const client = validateGurgurClientTrace(record.client);
  if (client.captureId !== captureId) throw new Error("client captureId does not match capture.id");
  const analysis = object(record.analysis, "analysis");
  if (analysis.analysisVersion !== GURGUR_TRACE_ANALYSIS_VERSION)
    throw new Error("analysis.analysisVersion is unsupported");
  exactKeys(
    record,
    [
      "format",
      "formatVersion",
      "generatedAt",
      "capture",
      "session",
      "coordinateSystem",
      "server",
      "client",
      "analysis",
    ],
    "network trace",
  );
  return value as GurgurNetworkTrace;
}

export function analyzeGurgurTrace(
  server: GurgurNetworkTrace["server"],
  client: GurgurClientTrace,
  playerId: RuntimeId,
): GurgurTraceAnalysis {
  const wirePosition: number[] = [];
  const wireRotation: number[] = [];
  const wireLinearVelocity: number[] = [];
  const wireAngularVelocity: number[] = [];
  let selectedRecords = 0;
  let wireRecords = 0;
  let missingWireRecords = 0;
  for (const outbound of server.outboundSnapshots) {
    if (!outbound.selected || !outbound.wire) continue;
    const wireBodies = bodyMap(outbound.wire.bodies);
    selectedRecords += outbound.selected.bodies.length;
    wireRecords += outbound.wire.bodies.length;
    for (const selected of outbound.selected.bodies) {
      const wire = wireBodies.get(idKey(selected.id));
      if (!wire) {
        missingWireRecords += 1;
        continue;
      }
      wirePosition.push(positionError(selected, wire));
      wireRotation.push(rotationErrorDegrees(selected.rotation, wire.rotation));
      appendVelocityErrors(selected, wire, wireLinearVelocity, wireAngularVelocity);
    }
  }

  const outboundByTick = new Map<number, TraceOutboundSnapshot>();
  for (const outbound of server.outboundSnapshots)
    if (outbound.status === "sent" && outbound.wire)
      outboundByTick.set(outbound.serverTick, outbound);
  const deliveryPosition: number[] = [];
  const deliveryRotation: number[] = [];
  const deliveryLinearVelocity: number[] = [];
  const deliveryAngularVelocity: number[] = [];
  let matchedSnapshots = 0;
  let unmatchedClientSnapshots = 0;
  let bodySetMismatches = 0;
  for (const received of client.snapshots) {
    const outbound = outboundByTick.get(received.snapshot.serverTick);
    if (!outbound?.wire) {
      unmatchedClientSnapshots += 1;
      continue;
    }
    matchedSnapshots += 1;
    const expected = bodyMap(outbound.wire.bodies);
    const actual = bodyMap(received.snapshot.bodies);
    if (
      expected.size !== actual.size ||
      [...expected.keys()].some((identity) => !actual.has(identity))
    )
      bodySetMismatches += 1;
    for (const [identity, expectedBody] of expected) {
      const actualBody = actual.get(identity);
      if (!actualBody) continue;
      deliveryPosition.push(positionError(expectedBody, actualBody));
      deliveryRotation.push(rotationErrorDegrees(expectedBody.rotation, actualBody.rotation));
      appendVelocityErrors(
        expectedBody,
        actualBody,
        deliveryLinearVelocity,
        deliveryAngularVelocity,
      );
    }
  }

  const reconciliations = client.prediction.filter(
    (
      record,
    ): record is TraceClientPredictionRecord & {
      event: TracePredictionReconciliationEvent;
    } => record.event.kind === "reconciliation",
  );
  const corrections = reconciliations.flatMap(({ event }) =>
    event.rawErrorMetres === null ? [] : [event.rawErrorMetres],
  );
  const tracedProxies = reconciliations.flatMap(({ event }) =>
    event.proxies.map((proxy) => ({ serverTick: event.serverTick, proxy })),
  );
  const proxyAuthorityAgeTicks = tracedProxies
    .filter(({ proxy }) => proxy.authorityTick >= 0)
    .map(({ serverTick, proxy }) => Math.max(0, serverTick - proxy.authorityTick));
  const proxyFreshnessTicksRemaining = tracedProxies.map(
    ({ proxy }) => proxy.freshnessTicksRemaining,
  );
  const disabledContactProxySamples = tracedProxies.filter(
    ({ proxy }) => proxy.contactPresentation && !proxy.collisionEnabled,
  ).length;
  const reconciliationOutcomes: Record<string, number> = {};
  for (const { event } of reconciliations)
    reconciliationOutcomes[event.outcome] = (reconciliationOutcomes[event.outcome] ?? 0) + 1;
  const worstCorrections = reconciliations
    .flatMap(({ clientAtMs, event }) =>
      event.rawErrorMetres === null
        ? []
        : [
            {
              serverTick: event.serverTick,
              clientAtMs,
              rawErrorMetres: event.rawErrorMetres,
              outcome: event.outcome,
              acknowledgedInputSequence: event.acknowledgedInputSequence,
              replayedInputCount: event.replayedInputSequences.length,
            },
          ],
    )
    .toSorted((left, right) => right.rawErrorMetres - left.rawErrorMetres)
    .slice(0, 10);

  const serverFrames = server.frames.toSorted((left, right) => left.serverTick - right.serverTick);
  const presentationErrors = new Map<
    TracePresentedBodySource,
    { position: number[]; rotation: number[] }
  >();
  const worstPresentation: TraceWorstPresentation[] = [];
  let missingAuthoritySamples = 0;
  for (const frame of client.presentation) {
    for (const presented of frame.bodies) {
      const authority = sampleServerBody(
        serverFrames,
        presented.body.id,
        presented.comparisonServerTick,
      );
      if (!authority) {
        missingAuthoritySamples += 1;
        continue;
      }
      const position = positionError(authority, presented.body);
      const rotation = rotationErrorDegrees(authority.rotation, presented.body.rotation);
      const stream = presentationErrors.get(presented.source) ?? {
        position: [],
        rotation: [],
      };
      stream.position.push(position);
      stream.rotation.push(rotation);
      presentationErrors.set(presented.source, stream);
      worstPresentation.push({
        serverTick: presented.comparisonServerTick,
        clientAtMs: frame.clientAtMs,
        id: { ...presented.body.id },
        source: presented.source,
        positionErrorMetres: position,
        rotationErrorDegrees: rotation,
      });
    }
  }

  const inputAt = new Map(client.inputs.map((input) => [input.command.sequence, input.clientAtMs]));
  const acknowledgementMs: number[] = [];
  const seenAcknowledgements = new Set<number>();
  for (const received of client.snapshots) {
    const authority = received.snapshot.players.find((player) => sameId(player.id, playerId));
    const sequence = authority?.lastProcessedInputSequence;
    if (sequence === undefined || sequence < 0 || seenAcknowledgements.has(sequence)) continue;
    seenAcknowledgements.add(sequence);
    const sampledAt = inputAt.get(sequence);
    if (sampledAt !== undefined)
      acknowledgementMs.push(Math.max(0, received.clientReceivedAtMs - sampledAt));
  }
  const snapshotAgeMs = client.snapshots.map((received) =>
    Math.max(
      0,
      ((received.estimatedServerTickAtReceipt - received.snapshot.serverTick) * 1_000) / PHYSICS_HZ,
    ),
  );
  const replayedInputs = reconciliations.map(({ event }) => event.replayedInputSequences.length);

  return {
    analysisVersion: GURGUR_TRACE_ANALYSIS_VERSION,
    wireQuantization: {
      positionMetres: summarize(wirePosition),
      rotationDegrees: summarize(wireRotation),
      linearVelocityMetresPerSecond: summarize(wireLinearVelocity),
      angularVelocityRadiansPerSecond: summarize(wireAngularVelocity),
      selectedRecords,
      wireRecords,
      missingWireRecords,
    },
    clientDelivery: {
      positionMetres: summarize(deliveryPosition),
      rotationDegrees: summarize(deliveryRotation),
      linearVelocityMetresPerSecond: summarize(deliveryLinearVelocity),
      angularVelocityRadiansPerSecond: summarize(deliveryAngularVelocity),
      outboundSent: [...outboundByTick.values()].length,
      clientReceived: client.snapshots.length,
      matchedSnapshots,
      unmatchedClientSnapshots,
      bodySetMismatches,
      droppedBackpressure: server.outboundSnapshots.filter(
        (record) => record.status === "dropped-backpressure",
      ).length,
      transportUnavailable: server.outboundSnapshots.filter(
        (record) => record.status === "transport-unavailable",
      ).length,
      sendFailed: server.outboundSnapshots.filter((record) => record.status === "send-failed")
        .length,
    },
    prediction: {
      rawCorrectionMetres: summarize(corrections),
      proxyAuthorityAgeTicks: summarize(proxyAuthorityAgeTicks),
      proxyFreshnessTicksRemaining: summarize(proxyFreshnessTicksRemaining),
      disabledContactProxySamples,
      reconciliationOutcomes,
      worstCorrections,
    },
    presentation: {
      bySource: Object.fromEntries(
        [...presentationErrors].map(([source, errors]) => [
          source,
          {
            positionMetres: summarize(errors.position),
            rotationDegrees: summarize(errors.rotation),
          },
        ]),
      ),
      missingAuthoritySamples,
      worst: worstPresentation
        .toSorted((left, right) => right.positionErrorMetres - left.positionErrorMetres)
        .slice(0, 20),
    },
    timing: {
      inputAcknowledgementMs: summarize(acknowledgementMs),
      snapshotAgeMs: summarize(snapshotAgeMs),
      replayedInputs: summarize(replayedInputs),
    },
    notes: [
      "Prediction corrections compare the client prediction immediately before reconciliation with the post-authority replay result.",
      "Interpolated presentation is compared at presentationTargetTick; current contact and predicted presentation are compared at estimatedServerTick.",
      "Predicted-local presentation error includes intentional client lead and is diagnostic, not a determinism assertion.",
      `Server authority is sampled at ${PHYSICS_HZ} Hz and outbound state at ${SNAPSHOT_HZ} Hz.`,
    ],
  };
}

function sampleServerBody(
  frames: TraceServerFrame[],
  id: RuntimeId,
  tick: number,
): BodySnapshot | null {
  let older: TraceServerFrame | null = null;
  let newer: TraceServerFrame | null = null;
  for (const frame of frames) {
    if (frame.serverTick <= tick) older = frame;
    if (frame.serverTick >= tick) {
      newer = frame;
      break;
    }
  }
  if (!older || !newer) return null;
  const olderBody = older ? frameBody(older, id) : null;
  const newerBody = newer ? frameBody(newer, id) : null;
  if (!olderBody) return newerBody;
  if (!newerBody) return olderBody;
  if (older.serverTick === newer.serverTick) return newerBody;
  const amount = Math.max(
    0,
    Math.min(1, (tick - older.serverTick) / (newer.serverTick - older.serverTick)),
  );
  return {
    id: { ...id },
    position: lerpVec3(olderBody.position, newerBody.position, amount),
    rotation: lerpQuat(olderBody.rotation, newerBody.rotation, amount),
    linearVelocity: newerBody.linearVelocity,
    angularVelocity: newerBody.angularVelocity,
  };
}

function frameBody(frame: TraceServerFrame, id: RuntimeId): BodySnapshot | null {
  const body = frame.bodies.find((candidate) => sameId(candidate.id, id));
  if (body) return body;
  const player = frame.players.find((candidate) => sameId(candidate.id, id));
  if (!player) return null;
  return {
    id: { ...player.id },
    position: { ...player.position },
    rotation: yawRotation(player.yaw),
    linearVelocity: { x: 0, y: player.verticalVelocity, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
}

function summarize(values: number[]): TraceMetricSummary {
  const finite = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (finite.length === 0) return { samples: 0, p50: null, p95: null, p99: null, max: null };
  const percentile = (amount: number): number =>
    finite[Math.min(finite.length - 1, Math.floor((finite.length - 1) * amount))]!;
  return {
    samples: finite.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: finite.at(-1)!,
  };
}

function bodyMap(bodies: BodySnapshot[]): Map<string, BodySnapshot> {
  return new Map(bodies.map((body) => [idKey(body.id), body]));
}

function positionError(left: { position: Vec3 }, right: { position: Vec3 }): number {
  return Math.hypot(
    left.position.x - right.position.x,
    left.position.y - right.position.y,
    left.position.z - right.position.z,
  );
}

function appendVelocityErrors(
  left: BodySnapshot,
  right: BodySnapshot,
  linearErrors: number[],
  angularErrors: number[],
): void {
  if (left.linearVelocity && right.linearVelocity)
    linearErrors.push(vectorError(left.linearVelocity, right.linearVelocity));
  if (left.angularVelocity && right.angularVelocity)
    angularErrors.push(vectorError(left.angularVelocity, right.angularVelocity));
}

function vectorError(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function rotationErrorDegrees(left: Quat, right: Quat): number {
  const dot = Math.min(
    1,
    Math.abs(left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w),
  );
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

function lerpVec3(left: Vec3, right: Vec3, amount: number): Vec3 {
  return {
    x: left.x + (right.x - left.x) * amount,
    y: left.y + (right.y - left.y) * amount,
    z: left.z + (right.z - left.z) * amount,
  };
}

function lerpQuat(left: Quat, right: Quat, amount: number): Quat {
  const dot = left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w;
  const sign = dot < 0 ? -1 : 1;
  const x = left.x + (right.x * sign - left.x) * amount;
  const y = left.y + (right.y * sign - left.y) * amount;
  const z = left.z + (right.z * sign - left.z) * amount;
  const w = left.w + (right.w * sign - left.w) * amount;
  const length = Math.hypot(x, y, z, w) || 1;
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

function yawRotation(yaw: number): Quat {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function idKey(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}

function sameId(left: RuntimeId, right: RuntimeId): boolean {
  return left.index === right.index && left.generation === right.generation;
}

function validateJsonTree(value: unknown, depth: number): void {
  if (depth > 16) throw new Error("client trace nesting is too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("client trace contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > GURGUR_TRACE_MAX_CLIENT_RECORDS)
      throw new Error("client trace array exceeds record limit");
    for (const item of value) validateJsonTree(item, depth + 1);
    return;
  }
  if (typeof value !== "object") throw new Error("client trace contains a non-JSON value");
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error("client trace object has too many fields");
  for (const [key, item] of entries) {
    if (key.length > 128) throw new Error("client trace field name is too long");
    validateJsonTree(item, depth + 1);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function runtimeId(value: unknown, label: string): RuntimeId {
  const record = object(value, label);
  const id = {
    index: safeInteger(record.index, `${label}.index`, 0),
    generation: safeInteger(record.generation, `${label}.generation`, 0),
  };
  exactKeys(record, ["index", "generation"], label);
  return id;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be a finite number`);
  return value;
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error(`${label} must be a safe integer at least ${minimum}`);
  return value as number;
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum)
    throw new Error(`${label} must be a string between ${minimum} and ${maximum} characters`);
  return value;
}

function isoDate(value: unknown, label: string): string {
  const text = boundedString(value, label, 1, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO date`);
  return text;
}

function boundedArray<T>(
  value: unknown,
  label: string,
  maximum = GURGUR_TRACE_MAX_CLIENT_RECORDS,
): T[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`${label} must be an array with at most ${maximum} records`);
  return value as T[];
}

function exactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(record).some((key) => !expected.has(key)) || keys.some((key) => !(key in record)))
    throw new Error(`${label} fields are invalid`);
}
