import { createSnapshotTimeline } from "./interpolation";
import { WorldRenderer } from "./renderer";
import { GameSession } from "./session";
import { createPlayerInput } from "./input";
import { createPredictionClient } from "./prediction-client";
import type { PhysicsDebugFrame } from "@gurgur/shared";

const canvas = document.querySelector<HTMLCanvasElement>("#world");
if (!canvas) throw new Error("game canvas is missing");
const searchParams = new URLSearchParams(location.search);
const debugEnabled = searchParams.has("debug") && searchParams.get("debug") !== "0";

const textureManifestResponse = await fetch("/textures.json", { cache: "no-cache" });
if (!textureManifestResponse.ok)
  throw new Error("authored material texture manifest is unavailable");
const textureManifest = (await textureManifestResponse.json()) as unknown;
if (!textureManifest || typeof textureManifest !== "object" || Array.isArray(textureManifest)) {
  throw new Error("authored material texture manifest is invalid");
}
const materialTextureUrls = Object.fromEntries(
  Object.entries(textureManifest).map(([name, url]) => {
    if (typeof url !== "string" || !url.startsWith("/textures/")) {
      throw new Error(`authored material texture URL is invalid: ${name}`);
    }
    return [name, url];
  }),
);

const history = createSnapshotTimeline();
let heavyCube: { key: string; localTop: number } | null = null;
const renderer = new WorldRenderer(
  canvas,
  history,
  (body) => {
    document.body.dataset.renderedX = String(body.position.x);
    document.body.dataset.renderedY = String(body.position.y);
    document.body.dataset.renderedZ = String(body.position.z);
  },
  (body) => {
    if (`${body.id.index}:${body.id.generation}` !== heavyCube?.key) return;
    document.body.dataset.renderedHeavyCubeX = String(body.position.x);
    document.body.dataset.renderedHeavyCubeY = String(body.position.y);
    document.body.dataset.renderedHeavyCubeZ = String(body.position.z);
    document.body.dataset.renderedHeavyCubeQx = String(body.rotation.x);
    document.body.dataset.renderedHeavyCubeQy = String(body.rotation.y);
    document.body.dataset.renderedHeavyCubeQz = String(body.rotation.z);
    document.body.dataset.renderedHeavyCubeQw = String(body.rotation.w);
  },
  materialTextureUrls,
  debugEnabled,
);
const predictor = createPredictionClient((body, bodies, correctionMagnitude) => {
  renderer.setPredictedPlayer(body);
  renderer.setPredictedBodies(bodies);
  const predictedHeavyCube = bodies.find(
    (candidate) => `${candidate.id.index}:${candidate.id.generation}` === heavyCube?.key,
  );
  document.body.dataset.predictedBodyCount = String(bodies.length);
  document.body.dataset.predictedHeavyCubeX = predictedHeavyCube
    ? String(predictedHeavyCube.position.x)
    : "";
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
      const runtime = message.runtimeEntities.find(
        (entity) => entity.classname === "func_physics" && "brushIndex" in entity,
      );
      if (runtime && "brushIndex" in runtime) {
        const brush = message.bundle.brushes[runtime.brushIndex];
        heavyCube = brush
          ? {
              key: `${runtime.id.index}:${runtime.id.generation}`,
              localTop: Math.max(...brush.localVertices.map((vertex) => vertex.y)),
            }
          : null;
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
      if (heavyCube) {
        const body = message.bodies.find(
          (candidate) => `${candidate.id.index}:${candidate.id.generation}` === heavyCube!.key,
        );
        if (body) {
          document.body.dataset.heavyCubeX = String(body.position.x);
          document.body.dataset.heavyCubeY = String(body.position.y);
          document.body.dataset.heavyCubeZ = String(body.position.z);
          document.body.dataset.heavyCubeTopY = String(body.position.y + heavyCube.localTop);
        }
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
      const response = await fetch("/debug/physics", {
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
