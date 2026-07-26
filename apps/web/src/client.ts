import { WorldRenderer } from "./renderer";
import { GameSession } from "./session";
import { createPlayerInput } from "./input";
import { WorldAudio } from "./audio";
import type { PhysicsDebugFrame } from "@gurgur/engine";
import { parseDevFollowCamera, type DevFollowCamera } from "./dev-follow";
import { installSpeechChat, type SpeechChat } from "./speech-chat";
import { SpeechSynthesizer } from "./speech-synthesis";

const canvas = document.querySelector<HTMLCanvasElement>("#world");
if (!canvas) throw new Error("game canvas is missing");
document.body.dataset.playerViewReady = "false";
const searchParams = new URLSearchParams(location.search);
const debugEnabled = searchParams.has("debug") && searchParams.get("debug") !== "0";
const testEnabled = searchParams.has("test") && searchParams.get("test") !== "0";
const requestedFollowCamera = parseDevFollowCamera(searchParams);
let followCamera: DevFollowCamera | null = null;
if (searchParams.has("follow")) {
  document.body.dataset.followCamera = requestedFollowCamera ? "checking" : "invalid";
  if (requestedFollowCamera) {
    try {
      const response = await fetch("/debug/client-capabilities", { cache: "no-store" });
      const clientCapabilities = response.ok ? ((await response.json()) as unknown) : null;
      const clientFollowEnabled =
        clientCapabilities !== null &&
        typeof clientCapabilities === "object" &&
        !Array.isArray(clientCapabilities) &&
        (clientCapabilities as { followCamera?: unknown }).followCamera === true;
      if (clientFollowEnabled) {
        followCamera = requestedFollowCamera;
        document.body.dataset.followCamera = "waiting";
        document.body.dataset.followTarget = `${followCamera.target.index}:${followCamera.target.generation}`;
        document.body.dataset.followYaw = String(followCamera.yaw);
        document.body.dataset.followPitch = String(followCamera.pitch);
      } else {
        document.body.dataset.followCamera = "unavailable";
      }
    } catch {
      document.body.dataset.followCamera = "unavailable";
    }
  }
}

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
  Array.isArray(assetManifest.sprites) ||
  !assetManifest.audio ||
  typeof assetManifest.audio !== "object" ||
  Array.isArray(assetManifest.audio)
)
  throw new Error("authored asset manifest is invalid");
const materialTextureUrls = Object.fromEntries(
  Object.entries(assetManifest.materials).map(([name, value]) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as { url?: unknown }).url !== "string" ||
      !(value as { url: string }).url.startsWith("/textures/") ||
      !Number.isSafeInteger((value as { width?: unknown }).width) ||
      (value as { width: number }).width <= 0 ||
      !Number.isSafeInteger((value as { height?: unknown }).height) ||
      (value as { height: number }).height <= 0 ||
      !["retro", "reality"].includes((value as { renderMode?: string }).renderMode ?? "")
    )
      throw new Error(`authored material texture metadata is invalid: ${name}`);
    return [
      name,
      {
        url: (value as { url: string }).url,
        width: (value as { width: number }).width,
        height: (value as { height: number }).height,
        renderMode: (value as { renderMode: "retro" | "reality" }).renderMode,
      },
    ];
  }),
);
const spriteAssetUrls = Object.fromEntries(
  Object.entries(assetManifest.sprites).map(([name, url]) => {
    if (typeof url !== "string" || !url.startsWith("/sprites/"))
      throw new Error(`authored sprite URL is invalid: ${name}`);
    return [name, url];
  }),
);
const audioAssetUrls = Object.fromEntries(
  Object.entries(assetManifest.audio).map(([name, url]) => {
    if (typeof url !== "string" || !url.startsWith("/audio/"))
      throw new Error(`authored audio URL is invalid: ${name}`);
    return [name, url];
  }),
);
const speechAssets = assetManifest.speech;
if (
  !speechAssets ||
  typeof speechAssets !== "object" ||
  Array.isArray(speechAssets) ||
  typeof (speechAssets as { workerUrl?: unknown }).workerUrl !== "string" ||
  !(speechAssets as { workerUrl: string }).workerUrl.startsWith("/speech-worker.js") ||
  typeof (speechAssets as { scriptUrl?: unknown }).scriptUrl !== "string" ||
  !(speechAssets as { scriptUrl: string }).scriptUrl.startsWith("/lintalker.js?v=") ||
  typeof (speechAssets as { wasmUrl?: unknown }).wasmUrl !== "string" ||
  !(speechAssets as { wasmUrl: string }).wasmUrl.startsWith("/lintalker.wasm?v=")
) {
  throw new Error("speech asset metadata is invalid");
}
const speechAssetUrls = speechAssets as {
  workerUrl: string;
  scriptUrl: string;
  wasmUrl: string;
};
const worldAudio = new WorldAudio(audioAssetUrls, (state) => {
  document.body.dataset.audioState = state.state;
  document.body.dataset.audioAsset = state.asset ?? "";
});

const diagnosticBodies = new Map<
  string,
  {
    entityIndex: number;
    localTop: number;
    authoritative?: {
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
      camera: () => renderer.cameraDiagnostics(),
      speech: () => renderer.speechDiagnostics(),
    }),
  });
}
const renderer = new WorldRenderer(
  canvas,
  (body) => {
    document.body.dataset.renderedX = String(body.position.x);
    document.body.dataset.renderedY = String(body.position.y);
    document.body.dataset.renderedZ = String(body.position.z);
    if (!followCamera) document.body.dataset.playerViewReady = "true";
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
const speechSynthesizer = new SpeechSynthesizer({
  ...speechAssetUrls,
  onSpeech(speech) {
    document.body.dataset.lastSpeechSampleCount = String(speech.samples.length);
    document.body.dataset.lastSpeechPlayed = String(
      renderer.playSpeech(speech.speakerId, speech.sampleRate, speech.samples),
    );
  },
});
if (followCamera) {
  renderer.setViewAngles(followCamera.yaw, followCamera.pitch);
  renderer.setFollowCamera(followCamera.target, (body) => {
    document.body.dataset.followX = String(body.position.x);
    document.body.dataset.followY = String(body.position.y);
    document.body.dataset.followZ = String(body.position.z);
    document.body.dataset.followCamera = "ready";
    document.body.dataset.playerViewReady = "true";
  });
}
let localPlayerKey: string | null = null;
let session: GameSession;
let speechChat: SpeechChat | null = null;
let loadedWorldEpoch: number | null = null;
let stateTransportReady = false;
const enableInputIfReady = (): void => {
  if (stateTransportReady && loadedWorldEpoch !== null) {
    input.setWorld(loadedWorldEpoch);
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
    document.body.dataset.inputSequence = String(command.sequence);
    session.sendInput(command);
  },
  (yaw, pitch) => {
    if (!followCamera) renderer.setViewAngles(yaw, pitch);
  },
  () => {
    const target = renderer.interactionTarget();
    document.body.dataset.interactionTarget = target ? `${target.index}:${target.generation}` : "";
    document.body.dataset.interactionOutline = renderer.interactionOutlineState();
    return target;
  },
);
session = new GameSession(
  {
    status(status, close) {
      document.body.dataset.connection = status;
      document.body.dataset.ready = status === "connected" ? "true" : "false";
      speechChat?.setEnabled(status === "connected");
      if (close) {
        document.body.dataset.closeCode = String(close.code);
        document.body.dataset.closeReason = close.reason;
      } else {
        delete document.body.dataset.closeCode;
        delete document.body.dataset.closeReason;
      }
    },
    welcome(message) {
      localPlayerKey = `${message.playerId.index}:${message.playerId.generation}`;
      renderer.setLocalPlayer(message.playerId);
    },
    world(message) {
      document.body.dataset.playerViewReady = "false";
      speechSynthesizer.reset();
      renderer.setWorld(message);
      worldAudio.setWorld(message.bundle);
      document.body.dataset.inputReady = "false";
      loadedWorldEpoch = message.worldEpoch;
      enableInputIfReady();
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
    snapshot(message) {
      renderer.applySnapshot(message);
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
        worldAudio.update(player.position);
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
    network(rttMs, jitterMs) {
      document.body.dataset.rttMs = rttMs.toFixed(1);
      document.body.dataset.jitterMs = jitterMs.toFixed(1);
    },
    transport(state) {
      document.body.dataset.transport = state;
      stateTransportReady = state === "webrtc";
      if (stateTransportReady) enableInputIfReady();
      else document.body.dataset.inputReady = "false";
    },
    speech(message) {
      document.body.dataset.lastSpeechText = message.text;
      document.body.dataset.lastSpeechSpeaker = `${message.speakerId.index}:${message.speakerId.generation}`;
      speechSynthesizer.enqueue(message);
    },
    speechRejected(message) {
      speechChat?.rejected(message.retryAfterMs, message.reason === "world-changed");
    },
  },
  {
    simulatedLatencyMs: Number(searchParams.get("simulatedLatencyMs") ?? 0),
  },
);
const speechForm = document.querySelector<HTMLFormElement>("#speech-chat");
const speechField = document.querySelector<HTMLInputElement>("#speech-text");
const speechStatus = document.querySelector<HTMLOutputElement>("#speech-status");
if (!speechForm || !speechField || !speechStatus) throw new Error("speech chat UI is missing");
speechChat = installSpeechChat({
  form: speechForm,
  field: speechField,
  status: speechStatus,
  input,
  submit: (requestId, text) => session.speak(requestId, text),
});

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
const unlockAudio = (): void => {
  void worldAudio.unlock();
  void renderer.unlockSpeechAudio();
};
addEventListener("pointerdown", unlockAudio, { passive: true, capture: true });
addEventListener("keydown", unlockAudio, { capture: true });
addEventListener("pagehide", () => {
  if (debugPoll !== null) clearInterval(debugPoll);
  debugRequest?.abort();
  session.close();
  speechChat?.dispose();
  speechSynthesizer.dispose();
  input.dispose();
  removeEventListener("pointerdown", unlockAudio, { capture: true });
  removeEventListener("keydown", unlockAudio, { capture: true });
  worldAudio.dispose();
  renderer.dispose();
});
