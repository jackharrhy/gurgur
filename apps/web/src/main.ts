import { createSnapshotTimeline } from "./interpolation";
import { WorldRenderer } from "./renderer";
import { GameSession } from "./session";
import { createPlayerInput } from "./input";
import { createPredictionClient } from "./prediction-client";

const canvas = document.querySelector<HTMLCanvasElement>("#world");
if (!canvas) throw new Error("game canvas is missing");

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
  },
);
const predictor = createPredictionClient((body, bodies, correctionMagnitude) => {
  renderer.setPredictedPlayer(body);
  renderer.setPredictedBodies(bodies);
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
const input = createPlayerInput(
  canvas,
  (command) => {
    session.sendInput(command);
    predictor.pushInput(command);
  },
  (yaw, pitch) => renderer.setViewAngles(yaw, pitch),
  () => {
    const target = renderer.interactionTarget();
    document.body.dataset.interactionTarget = target ? `${target.index}:${target.generation}` : "";
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
      void predictor.setWorld(message).then(() => input.setWorld(message.worldEpoch));
      const runtime = message.runtimeEntities.find(
        (entity) => entity.authoredId === "physics.cube.heavy",
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
      history.push(message);
      if (!latestInFrame) return;
      predictor.reconcile(message);
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
  },
  {
    simulatedLatencyMs: Number(new URLSearchParams(location.search).get("simulatedLatencyMs") ?? 0),
  },
);

renderer.start();
session.connect();
addEventListener("pagehide", () => {
  session.close();
  input.dispose();
  predictor.dispose();
  renderer.dispose();
});
