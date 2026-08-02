import type { RuntimeId } from "@gurgur/engine";
import type { PredictionTraceFrame } from "./prediction-trace";

export const DEBUG_PHYSICS_CAPTURE_SECONDS = 15;

export type ServerPhysicsCaptureStart = {
  id: string;
  worldEpoch: number;
  mapRevision: string;
  playerId: RuntimeId;
  startedAtServerTick: number;
  endingAtServerTick: number;
  durationSeconds: number;
};

export type DebugPhysicsCaptureArtifact = {
  format: "gurgur-networked-physics-capture";
  version: 1;
  durationSeconds: 15;
  capturedAt: {
    startedAtIso: string;
    completedAtIso: string;
    clientPerformanceTimeOriginMs: number;
    clientStartedAtMs: number;
    clientCompletedAtMs: number;
  };
  context: {
    url: string;
    userAgent: string;
    mapRevision: string;
    worldEpoch: number;
    localPlayerId: RuntimeId;
    network: {
      rttMs: number | null;
      jitterMs: number | null;
      transport: string | null;
      simulatedLatencyMs: number;
      simulatedJitterMs: number;
      simulatedLossRate: number;
      simulatedSeed: number;
    };
  };
  client: {
    discardedCatchUpSeconds: number;
    feel: unknown;
    frames: PredictionTraceFrame[];
  };
  server: unknown;
};

export function buildDebugPhysicsCapture(
  artifact: Omit<DebugPhysicsCaptureArtifact, "format" | "version" | "durationSeconds">,
): DebugPhysicsCaptureArtifact {
  return structuredClone({
    format: "gurgur-networked-physics-capture",
    version: 1,
    durationSeconds: DEBUG_PHYSICS_CAPTURE_SECONDS,
    ...artifact,
  });
}

export function debugPhysicsCaptureFilename(completedAtIso: string, compressed = true): string {
  const timestamp = completedAtIso.replace(/[:.]/g, "-");
  return `gurgur-physics-${timestamp}.json${compressed ? ".gz" : ""}`;
}

export async function downloadDebugPhysicsCapture(
  artifact: DebugPhysicsCaptureArtifact,
): Promise<void> {
  const json = new Blob([JSON.stringify(artifact)], { type: "application/json" });
  const compressed = typeof CompressionStream !== "undefined";
  const download = compressed
    ? await new Response(json.stream().pipeThrough(new CompressionStream("gzip"))).blob()
    : json;
  const url = URL.createObjectURL(download);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = debugPhysicsCaptureFilename(artifact.capturedAt.completedAtIso, compressed);
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
