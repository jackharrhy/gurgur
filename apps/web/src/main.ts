import { createSnapshotTimeline } from "./interpolation";
import { WorldRenderer } from "./renderer";
import { GameSession } from "./session";
import { createPlayerInput } from "./input";
import { createPredictionClient } from "./prediction-client";
import type { PhysicsDebugFrame } from "@gurgur/engine";

const canvas = document.querySelector<HTMLCanvasElement>("#world");
if (!canvas) throw new Error("game canvas is missing");
const searchParams = new URLSearchParams(location.search);
const debugEnabled = searchParams.has("debug") && searchParams.get("debug") !== "0";
const testEnabled = searchParams.has("test") && searchParams.get("test") !== "0";

const textureManifestResponse = await fetch("/assets.json", { cache: "no-cache" });
if (!textureManifestResponse.ok)
  throw new Error("authored material texture manifest is unavailable");
const textureManifest = (await textureManifestResponse.json()) as unknown;
if (!textureManifest || typeof textureManifest !== "object" || Array.isArray(textureManifest)) {
  throw new Error("authored material texture manifest is invalid");
}
const assetManifest = textureManifest as Record<string, unknown>;
if (
  !assetManifest.materials ||
  typeof assetManifest.materials !== "object" ||
  Array.isArray(assetManifest.materials) ||
  !assetManifest.sprites ||
  typeof assetManifest.sprites !== "object" ||
  Array.isArray(assetManifest.sprites)
)
  throw new Error("authored asset manifest is invalid");
const materialTextureUrls = Object.fromEntries(
  Object.entries(assetManifest.materials).map(([name, url]) => {
    if (typeof url !== "string" || !url.startsWith("/textures/")) {
      throw new Error(`authored material texture URL is invalid: ${name}`);
    }
    return [name, url];
  }),
);
const spriteAssetUrls = Object.fromEntries(
  Object.entries(assetManifest.sprites).map(([name, url]) => {
    if (typeof url !== "string" || !url.startsWith("/sprites/"))
      throw new Error(`authored sprite URL is invalid: ${name}`);
    return [name, url];
  }),
);

const history = createSnapshotTimeline();
const diagnosticBodies = new Map<
  string,
  {
    entityIndex: number;
    localTop: number;
    authoritative?: {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
    };
    predicted?: {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
    };
    rendered?: {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
    };
  }
>();
if (testEnabled) {
  Object.defineProperty(window, "__gurgurDiagnostics", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      bodies: () =>
        [...diagnosticBodies.entries()].map(([runtimeId, body]) => ({
          runtimeId,
          ...structuredClone(body),
        })),
    }),
  });
}
const renderer = new WorldRenderer(
  canvas,
  history,
  (body) => {
    document.body.dataset.renderedX = String(body.position.x);
    document.body.dataset.renderedY = String(body.position.y);
    document.body.dataset.renderedZ = String(body.position.z);
  },
  (body) => {
    if (!testEnabled) return;
    const diagnostic = diagnosticBodies.get(`${body.id.index}:${body.id.generation}`);
    if (diagnostic)
      diagnostic.rendered = {
        position: { ...body.position },
        rotation: { ...body.rotation },
      };
  },
  materialTextureUrls,
  spriteAssetUrls,
  debugEnabled,
);
const predictor = createPredictionClient((body, bodies, correctionMagnitude) => {
  renderer.setPredictedPlayer(body);
  renderer.setPredictedBodies(bodies);
  if (testEnabled)
    for (const predicted of bodies) {
      const diagnostic = diagnosticBodies.get(`${predicted.id.index}:${predicted.id.generation}`);
      if (diagnostic)
        diagnostic.predicted = {
          position: { ...predicted.position },
          rotation: { ...predicted.rotation },
        };
    }
  document.body.dataset.predictedBodyCount = String(bodies.length);
  document.body.dataset.predictionReady = body ? "true" : "false";
  if (body) {
    document.body.dataset.predictedX = String(body.position.x);
    document.body.dataset.predictedY = String(body.position.y);
    document.body.dataset.predictedZ = String(body.position.z);
  }
  document.body.dataset.predictionCorrection = String(correctionMagnitude);
});
let localPlayerKey: string | null = null;
let session: GameSession;
let predictionWorldEpoch: number | null = null;
let snapshotEpochAfterTransport: number | null = null;
let stateTransportReady = false;
const enableInputIfReady = (): void => {
  if (
    stateTransportReady &&
    predictionWorldEpoch !== null &&
    snapshotEpochAfterTransport === predictionWorldEpoch
  ) {
    input.setWorld(predictionWorldEpoch);
    document.body.dataset.inputReady = "true";
  }
};
const input = createPlayerInput(
  canvas,
  (command) => {
    document.body.dataset.inputMoveX = String(command.moveX);
    document.body.dataset.inputMoveZ = String(command.moveZ);
    document.body.dataset.inputJumpCounter = String(command.jumpCounter);
    document.body.dataset.inputButtons = String(command.buttons);
    session.sendInput(command);
    predictor.pushInput(command);
  },
  (yaw, pitch) => renderer.setViewAngles(yaw, pitch),
  () => {
    const target = renderer.interactionTarget();
    document.body.dataset.interactionTarget = target ? `${target.index}:${target.generation}` : "";
    document.body.dataset.interactionOutline = renderer.interactionOutlineState();
    return target;
  },
);
session = new GameSession(
  {
    status(status) {
      document.body.dataset.connection = status;
      document.body.dataset.ready = status === "connected" ? "true" : "false";
    },
    welcome(message) {
      localPlayerKey = `${message.playerId.index}:${message.playerId.generation}`;
      renderer.setLocalPlayer(message.playerId);
      predictor.setLocalPlayer(message.playerId);
    },
    world(message) {
      renderer.setWorld(message);
      document.body.dataset.inputReady = "false";
      predictionWorldEpoch = null;
      snapshotEpochAfterTransport = null;
      void predictor.setWorld(message).then(() => {
        predictionWorldEpoch = message.worldEpoch;
        enableInputIfReady();
      });
      diagnosticBodies.clear();
      if (testEnabled)
        for (const runtime of message.runtimeEntities) {
          if (runtime.kind !== "world-entity") continue;
          const entity = message.bundle.entities[runtime.entityIndex];
          const brush = entity?.body
            ? message.bundle.brushes[entity.body.brushIndices[0]!]
            : undefined;
          if (!brush) continue;
          diagnosticBodies.set(`${runtime.id.index}:${runtime.id.generation}`, {
            entityIndex: runtime.entityIndex,
            localTop: Math.max(...brush.localVertices.map((vertex) => vertex.y)),
          });
        }
      document.body.dataset.worldReady = "true";
    },
    lifecycle(message) {
      renderer.applyLifecycle(message);
    },
    snapshot(message, latestInFrame) {
      renderer.applyAuthoritativeInteractionState(message.bodies);
      history.push(message);
      predictor.reconcile(message, latestInFrame);
      if (!latestInFrame) return;
      if (stateTransportReady) {
        snapshotEpochAfterTransport = message.worldEpoch;
        enableInputIfReady();
      }
      document.body.dataset.worldEpoch = String(message.worldEpoch);
      document.body.dataset.serverTick = String(message.serverTick);
      const player = message.bodies.find(
        (body) => `${body.id.index}:${body.id.generation}` === localPlayerKey,
      );
      if (player) {
        document.body.dataset.playerReady = "true";
        document.body.dataset.playerX = String(player.position.x);
        document.body.dataset.playerY = String(player.position.y);
        document.body.dataset.playerZ = String(player.position.z);
      }
      if (testEnabled)
        for (const body of message.bodies) {
          const diagnostic = diagnosticBodies.get(`${body.id.index}:${body.id.generation}`);
          if (diagnostic)
            diagnostic.authoritative = {
              position: { ...body.position },
              rotation: { ...body.rotation },
            };
        }
    },
    clock(serverTick, receivedAtMs, oneWayDelayMs) {
      history.observeServerTick(serverTick, receivedAtMs, oneWayDelayMs);
    },
    network(rttMs, jitterMs) {
      document.body.dataset.rttMs = rttMs.toFixed(1);
      document.body.dataset.jitterMs = jitterMs.toFixed(1);
    },
    transport(state) {
      document.body.dataset.transport = state;
      stateTransportReady = state === "webrtc";
      snapshotEpochAfterTransport = null;
      if (!stateTransportReady) document.body.dataset.inputReady = "false";
    },
  },
  {
    simulatedLatencyMs: Number(searchParams.get("simulatedLatencyMs") ?? 0),
  },
);

let debugPoll: number | null = null;
let debugRequest: AbortController | null = null;
if (debugEnabled) {
  document.body.dataset.debug = "true";
  const panel = document.createElement("output");
  panel.id = "debug-status";
  panel.textContent = "debug · waiting for authoritative physics";
  document.body.append(panel);
  const pollPhysics = async (): Promise<void> => {
    if (debugRequest) return;
    debugRequest = new AbortController();
    try {
      const response = await fetch("/debug/physics?test=1", {
        cache: "no-store",
        signal: debugRequest.signal,
      });
      if (!response.ok) throw new Error(`physics debug request failed (${response.status})`);
      const frame = (await response.json()) as PhysicsDebugFrame;
      renderer.applyPhysicsDebugFrame(frame);
      document.body.dataset.physicsDebugPrimitives = String(frame.primitives.length);
      panel.textContent = `debug · server tick ${frame.serverTick} · ${frame.primitives.length} physics primitives${frame.truncated ? " · truncated" : ""}`;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        panel.textContent =
          error instanceof Error ? `debug · ${error.message}` : "debug · unavailable";
      }
    } finally {
      debugRequest = null;
    }
  };
  void pollPhysics();
  debugPoll = window.setInterval(() => void pollPhysics(), 100);
}

renderer.start();
session.connect();
addEventListener("pagehide", () => {
  if (debugPoll !== null) clearInterval(debugPoll);
  debugRequest?.abort();
  session.close();
  input.dispose();
  predictor.dispose();
  renderer.dispose();
});
