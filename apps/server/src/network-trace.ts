import {
  GURGUR_TRACE_FORMAT,
  GURGUR_TRACE_FORMAT_VERSION,
  GURGUR_TRACE_MAX_CLIENT_RECORDS,
  GURGUR_TRACE_MAX_DURATION_MS,
  PHYSICS_HZ,
  SNAPSHOT_HZ,
  analyzeGurgurTrace,
  type GurgurClientTrace,
  type GurgurNetworkTrace,
  type GurgurTraceStartRequest,
  type GurgurTraceStartResponse,
  type RuntimeId,
  type TraceOutboundSnapshot,
  type TraceServerFrame,
  type TraceServerInput,
} from "@gurgur/engine";

const MAX_SERVER_FRAMES = Math.ceil((GURGUR_TRACE_MAX_DURATION_MS * PHYSICS_HZ) / 1_000) + 4;
const MAX_SERVER_BODY_RECORDS = 600_000;
const MAX_SERVER_INPUT_RECORDS = GURGUR_TRACE_MAX_CLIENT_RECORDS;
const MAX_OUTBOUND_RECORDS = Math.ceil((GURGUR_TRACE_MAX_DURATION_MS * SNAPSHOT_HZ) / 1_000) + 8;

type StopReason = GurgurNetworkTrace["capture"]["stopReason"];

type ActiveCapture = {
  id: string;
  playerId: RuntimeId;
  mapRevision: string;
  worldEpoch: number;
  buildRevision: string;
  serverStartedAt: string;
  startedAtMs: number;
  startTick: number;
  endTick: number;
  stopReason: StopReason | null;
  bodyRecords: number;
  frames: TraceServerFrame[];
  inputs: TraceServerInput[];
  outboundSnapshots: TraceOutboundSnapshot[];
  truncatedStreams: Set<string>;
  inputSequences: Set<number>;
};

export class NetworkTraceCapture {
  #capture: ActiveCapture | null = null;

  get activePlayerId(): RuntimeId | null {
    return this.#capture ? { ...this.#capture.playerId } : null;
  }

  get captureId(): string | null {
    return this.#capture?.id ?? null;
  }

  get collecting(): boolean {
    return this.#capture !== null && this.#capture.stopReason === null;
  }

  start(
    request: GurgurTraceStartRequest,
    serverTick: number,
    buildRevision: string,
  ): GurgurTraceStartResponse {
    if (this.collecting) throw new TraceConflictError("a network trace is already recording");
    const now = performance.now();
    const serverStartedAt = new Date().toISOString();
    const id = crypto.randomUUID();
    this.#capture = {
      id,
      playerId: { ...request.playerId },
      mapRevision: request.mapRevision,
      worldEpoch: request.worldEpoch,
      buildRevision,
      serverStartedAt,
      startedAtMs: now,
      startTick: serverTick,
      endTick: serverTick,
      stopReason: null,
      bodyRecords: 0,
      frames: [],
      inputs: [],
      outboundSnapshots: [],
      truncatedStreams: new Set(),
      inputSequences: new Set(),
    };
    return {
      captureId: id,
      serverTick,
      serverStartedAt,
      maxDurationMs: GURGUR_TRACE_MAX_DURATION_MS,
    };
  }

  recordFrame(frame: Omit<TraceServerFrame, "serverAtMs">): boolean {
    const capture = this.#capture;
    if (!capture || capture.stopReason) return false;
    if (!this.#withinDuration(capture)) return false;
    if (
      frame.worldEpoch !== capture.worldEpoch ||
      frame.players.every((player) => !sameId(player.id, capture.playerId))
    ) {
      this.#freeze(capture, "world-changed", "frames");
      return false;
    }
    const frameBodyRecords = frame.bodies.length + frame.players.length;
    if (
      capture.frames.length >= MAX_SERVER_FRAMES ||
      capture.bodyRecords + frameBodyRecords > MAX_SERVER_BODY_RECORDS
    ) {
      this.#freeze(capture, "record-limit", "frames");
      return false;
    }
    capture.endTick = frame.serverTick;
    capture.bodyRecords += frameBodyRecords;
    capture.frames.push({
      ...frame,
      serverAtMs: this.#elapsed(capture),
    });
    return true;
  }

  recordInput(
    playerId: RuntimeId,
    serverTickAtReceipt: number,
    transport: TraceServerInput["transport"],
    command: TraceServerInput["command"],
    accepted: boolean,
  ): void {
    const capture = this.#capture;
    if (!capture || capture.stopReason || !sameId(playerId, capture.playerId)) return;
    if (!this.#withinDuration(capture)) return;
    if (capture.inputs.length >= MAX_SERVER_INPUT_RECORDS) {
      this.#freeze(capture, "record-limit", "inputs");
      return;
    }
    const firstReceipt = !capture.inputSequences.has(command.sequence);
    capture.inputSequences.add(command.sequence);
    capture.inputs.push({
      serverTickAtReceipt,
      serverAtMs: this.#elapsed(capture),
      transport,
      command: structuredClone(command),
      accepted,
      firstReceipt,
    });
  }

  recordOutbound(playerId: RuntimeId, snapshot: Omit<TraceOutboundSnapshot, "serverAtMs">): void {
    const capture = this.#capture;
    if (!capture || capture.stopReason || !sameId(playerId, capture.playerId)) return;
    if (!this.#withinDuration(capture)) return;
    if (capture.outboundSnapshots.length >= MAX_OUTBOUND_RECORDS) {
      this.#freeze(capture, "record-limit", "outboundSnapshots");
      return;
    }
    capture.endTick = Math.max(capture.endTick, snapshot.serverTick);
    capture.outboundSnapshots.push({
      ...snapshot,
      serverAtMs: this.#elapsed(capture),
    });
  }

  stop(captureId: string, client: GurgurClientTrace): GurgurNetworkTrace {
    const capture = this.#capture;
    if (!capture || capture.id !== captureId) throw new TraceNotFoundError();
    if (client.captureId !== captureId) throw new Error("client trace capture does not match");
    if (!capture.stopReason)
      capture.stopReason =
        this.#elapsed(capture) >= GURGUR_TRACE_MAX_DURATION_MS ? "duration-limit" : "user";
    const serverEndedAt = new Date().toISOString();
    const server = {
      startTick: capture.startTick,
      endTick: capture.endTick,
      frames: capture.frames,
      inputs: capture.inputs,
      outboundSnapshots: capture.outboundSnapshots,
      truncatedStreams: [...capture.truncatedStreams].toSorted(),
    };
    const trace: GurgurNetworkTrace = {
      format: GURGUR_TRACE_FORMAT,
      formatVersion: GURGUR_TRACE_FORMAT_VERSION,
      generatedAt: serverEndedAt,
      capture: {
        id: capture.id,
        serverStartedAt: capture.serverStartedAt,
        serverEndedAt,
        stopReason: capture.stopReason,
        limits: {
          maxDurationMs: GURGUR_TRACE_MAX_DURATION_MS,
          maxClientRecords: GURGUR_TRACE_MAX_CLIENT_RECORDS,
          maxServerFrames: MAX_SERVER_FRAMES,
          maxServerBodyRecords: MAX_SERVER_BODY_RECORDS,
        },
      },
      session: {
        buildRevision: capture.buildRevision,
        mapRevision: capture.mapRevision,
        worldEpoch: capture.worldEpoch,
        playerId: { ...capture.playerId },
        physicsHz: PHYSICS_HZ,
        snapshotHz: SNAPSHOT_HZ,
      },
      coordinateSystem: {
        linearUnits: "metres",
        angularUnits: "radians",
        handedness: "right",
        upAxis: "+Y",
        forwardAtZeroYaw: "-Z",
        timestamps: "milliseconds",
      },
      server,
      client,
      analysis: analyzeGurgurTrace(server, client, capture.playerId),
    };
    this.#capture = null;
    return trace;
  }

  cancel(): void {
    this.#capture = null;
  }

  #withinDuration(capture: ActiveCapture): boolean {
    if (this.#elapsed(capture) < GURGUR_TRACE_MAX_DURATION_MS) return true;
    this.#freeze(capture, "duration-limit");
    return false;
  }

  #freeze(capture: ActiveCapture, reason: StopReason, stream?: string): void {
    capture.stopReason = reason;
    if (stream) capture.truncatedStreams.add(stream);
  }

  #elapsed(capture: ActiveCapture): number {
    return Math.max(0, performance.now() - capture.startedAtMs);
  }
}

export class TraceConflictError extends Error {}
export class TraceNotFoundError extends Error {}

function sameId(left: RuntimeId, right: RuntimeId): boolean {
  return left.index === right.index && left.generation === right.generation;
}
