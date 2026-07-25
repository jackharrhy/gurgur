import {
  GURGUR_TRACE_FORMAT,
  GURGUR_TRACE_FORMAT_VERSION,
  type GurgurClientTrace,
  type GurgurTraceCapabilities,
  type GurgurTraceStartResponse,
  type InputCommand,
  type LifecycleMessage,
  type RuntimeId,
  type Snapshot,
  type TraceClientMarker,
  type TraceClockSample,
  type TraceNetworkSample,
  type TracePredictionEvent,
  type TracePresentationFrame,
} from "@gurgur/engine";

type SessionIdentity = {
  playerId: RuntimeId;
  worldEpoch: number;
  mapRevision: string;
};

type ActiveClientTrace = Omit<GurgurClientTrace, "clientEndedAt"> & {
  clientEndedAt: string | null;
};

export type ClientNetworkTraceRecorder = {
  readonly recording: boolean;
  readonly elapsedMs: number;
  setSession(identity: SessionIdentity | null): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  recordInput(command: InputCommand): void;
  recordSnapshotReceived(
    snapshot: Snapshot,
    estimatedServerTickAtReceipt: number,
    receivedAtMs: number,
  ): void;
  recordSnapshotProcessed(snapshot: Snapshot, latestInFrame: boolean, processedAtMs: number): void;
  recordPrediction(event: TracePredictionEvent): void;
  recordPresentation(frame: TracePresentationFrame): void;
  recordClock(sample: TraceClockSample): void;
  recordNetwork(sample: Omit<TraceNetworkSample, "clientAtMs">): void;
  recordMarker(marker: Omit<TraceClientMarker, "clientAtMs">): void;
  recordLifecycle(message: LifecycleMessage): void;
};

export async function installNetworkTraceControls(options: {
  onTraceEnabled(enabled: boolean): void | Promise<void>;
}): Promise<ClientNetworkTraceRecorder | null> {
  const capabilityResponse = await fetch("/debug/network-trace", { cache: "no-store" }).catch(
    () => null,
  );
  if (!capabilityResponse?.ok) return null;
  const capabilities = (await capabilityResponse.json()) as GurgurTraceCapabilities;
  if (
    capabilities.enabled !== true ||
    capabilities.format !== GURGUR_TRACE_FORMAT ||
    capabilities.formatVersion !== GURGUR_TRACE_FORMAT_VERSION
  )
    return null;

  const panel = document.createElement("section");
  panel.id = "network-trace-controls";
  panel.setAttribute("aria-label", "Network trace recorder");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Record trace";
  const status = document.createElement("output");
  status.textContent = `ready · ${Math.round(capabilities.maxDurationMs / 1_000)}s maximum`;
  panel.append(button, status);
  document.body.append(panel);

  let session: SessionIdentity | null = null;
  let active: ActiveClientTrace | null = null;
  let stopping = false;
  let stopTimer: number | null = null;
  let statusTimer: number | null = null;
  let totalRecords = 0;
  let lastPresentationAtMs = Number.NEGATIVE_INFINITY;
  const truncatedStreams = new Set<string>();

  const setSession = (identity: SessionIdentity | null): void => {
    if (
      active &&
      (!identity ||
        identity.worldEpoch !== session?.worldEpoch ||
        identity.mapRevision !== session.mapRevision ||
        !sameId(identity.playerId, session.playerId))
    ) {
      recordMarker({ kind: "world", value: "session changed during capture" });
      void stop();
    }
    session = identity ? structuredClone(identity) : null;
    button.disabled = stopping || (!active && !session);
  };

  const push = <T>(stream: string, target: T[], value: T): void => {
    if (!active) return;
    if (totalRecords >= capabilities.maxClientRecords) {
      truncatedStreams.add(stream);
      if (!stopping) void stop();
      return;
    }
    target.push(value);
    totalRecords += 1;
  };

  const recordMarker = (marker: Omit<TraceClientMarker, "clientAtMs">): void => {
    if (!active) return;
    push("markers", active.markers, { clientAtMs: performance.now(), ...marker });
  };

  const start = async (): Promise<void> => {
    if (active || stopping) return;
    if (!session) throw new Error("the connected player is not ready to record");
    button.disabled = true;
    status.textContent = "starting…";
    const response = await fetch("/debug/network-trace/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(session),
    });
    if (!response.ok) {
      button.disabled = false;
      throw new Error(await responseText(response, "trace start failed"));
    }
    const started = (await response.json()) as GurgurTraceStartResponse;
    totalRecords = 0;
    lastPresentationAtMs = Number.NEGATIVE_INFINITY;
    truncatedStreams.clear();
    active = {
      format: GURGUR_TRACE_FORMAT,
      formatVersion: GURGUR_TRACE_FORMAT_VERSION,
      captureId: started.captureId,
      clientStartedAt: new Date().toISOString(),
      clientEndedAt: null,
      clientTimeOriginUnixMs: performance.timeOrigin,
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      inputs: [],
      snapshots: [],
      prediction: [],
      presentation: [],
      clocks: [],
      network: [],
      markers: [],
      truncatedStreams: [],
    };
    await options.onTraceEnabled(true);
    recordMarker({
      kind: "world",
      value: `${session.mapRevision}@${session.worldEpoch}`,
      serverTick: started.serverTick,
    });
    button.disabled = false;
    button.textContent = "Stop and download";
    button.dataset.recording = "true";
    const startedAt = performance.now();
    const refreshStatus = (): void => {
      const elapsed = Math.min(started.maxDurationMs, performance.now() - startedAt);
      status.textContent = `recording · ${(elapsed / 1_000).toFixed(1)}s · ${totalRecords} client records`;
    };
    refreshStatus();
    statusTimer = window.setInterval(refreshStatus, 100);
    stopTimer = window.setTimeout(() => void stop(), started.maxDurationMs);
  };

  const stop = async (): Promise<void> => {
    if (!active || stopping) return;
    stopping = true;
    button.disabled = true;
    clearTimers();
    await options.onTraceEnabled(false);
    const completed: GurgurClientTrace = {
      ...active,
      clientEndedAt: new Date().toISOString(),
      truncatedStreams: [...truncatedStreams].toSorted(),
    };
    status.textContent = "joining server and client trace…";
    try {
      const response = await fetch("/debug/network-trace/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captureId: active.captureId, client: completed }),
      });
      if (!response.ok) throw new Error(await responseText(response, "trace stop failed"));
      const blob = await response.blob();
      downloadTrace(blob, `${active.captureId}.gurgur-trace.json`);
      status.textContent = `downloaded · ${(blob.size / (1024 * 1024)).toFixed(2)} MiB`;
      active = null;
      button.textContent = "Record trace";
      delete button.dataset.recording;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "trace download failed";
    } finally {
      stopping = false;
      button.disabled = !session;
    }
  };

  const clearTimers = (): void => {
    if (stopTimer !== null) clearTimeout(stopTimer);
    if (statusTimer !== null) clearInterval(statusTimer);
    stopTimer = null;
    statusTimer = null;
  };

  const recorder: ClientNetworkTraceRecorder = {
    get recording() {
      return active !== null;
    },
    get elapsedMs() {
      return active ? Date.now() - Date.parse(active.clientStartedAt) : 0;
    },
    setSession,
    start,
    stop,
    recordInput(command) {
      if (!active) return;
      push("inputs", active.inputs, {
        clientAtMs: performance.now(),
        command: structuredClone(command),
      });
    },
    recordSnapshotReceived(snapshot, estimatedServerTickAtReceipt, receivedAtMs) {
      if (!active) return;
      push("snapshots", active.snapshots, {
        clientReceivedAtMs: receivedAtMs,
        clientProcessedAtMs: null,
        latestInFrame: null,
        estimatedServerTickAtReceipt,
        snapshot: structuredClone(snapshot),
      });
    },
    recordSnapshotProcessed(snapshot, latestInFrame, processedAtMs) {
      if (!active) return;
      const received = active.snapshots.findLast(
        (record) =>
          record.snapshot.worldEpoch === snapshot.worldEpoch &&
          record.snapshot.serverTick === snapshot.serverTick,
      );
      if (received) {
        received.clientProcessedAtMs = processedAtMs;
        received.latestInFrame = latestInFrame;
      } else {
        push("snapshots", active.snapshots, {
          clientReceivedAtMs: processedAtMs,
          clientProcessedAtMs: processedAtMs,
          latestInFrame,
          estimatedServerTickAtReceipt: snapshot.serverTick,
          snapshot: structuredClone(snapshot),
        });
      }
    },
    recordPrediction(event) {
      if (!active) return;
      push("prediction", active.prediction, {
        clientAtMs: performance.now(),
        event: structuredClone(event),
      });
    },
    recordPresentation(frame) {
      if (!active) return;
      if (frame.clientAtMs - lastPresentationAtMs < 1_000 / 60) return;
      lastPresentationAtMs = frame.clientAtMs;
      push("presentation", active.presentation, structuredClone(frame));
    },
    recordClock(sample) {
      if (!active) return;
      push("clocks", active.clocks, sample);
    },
    recordNetwork(sample) {
      if (!active) return;
      push("network", active.network, { clientAtMs: performance.now(), ...sample });
    },
    recordMarker,
    recordLifecycle(message) {
      recordMarker({
        kind: "lifecycle",
        value: `created=${message.created.length},removed=${message.removed.length}`,
      });
    },
  };

  button.disabled = true;
  button.addEventListener("click", () => {
    const operation = active ? stop() : start();
    void operation.catch((error) => {
      status.textContent = error instanceof Error ? error.message : "trace recorder failed";
      button.disabled = !session;
    });
  });
  addEventListener("visibilitychange", () =>
    recordMarker({ kind: "visibility", value: document.visibilityState }),
  );
  return recorder;
}

function downloadTrace(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function responseText(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  return text || `${fallback} (${response.status})`;
}

function sameId(left: RuntimeId, right: RuntimeId): boolean {
  return left.index === right.index && left.generation === right.generation;
}
