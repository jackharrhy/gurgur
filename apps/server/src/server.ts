import webApp from "../../web/index.html";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { RTCPeerConnection, type RTCDataChannel, type RTCIceServer } from "werift";
import {
  PHYSICS_HZ,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  STATE_BACKPRESSURE_BYTES,
  STATE_MAX_RETRANSMITS,
  decodeInput,
  decodeClientControl,
  encodeLifecycle,
  encodeSnapshot,
  type InputCommand,
  type RuntimeId,
  type LifecycleMessage,
  type Snapshot,
  type SpeechMessage,
  type SpeechRejectedMessage,
  type Vec3,
  type WelcomeMessage,
  type ClientControlMessage,
  type WorldManifestMessage,
} from "@gurgur/engine";
import { encodeWorldBundle, type WorldBundle, type WorldMessage } from "@gurgur/game";
import { AuthoritativeGame } from "./game";
import {
  loadAssetManifest,
  loadAudioAsset,
  loadMaterialTextureAsset,
  loadSpriteAsset,
} from "./material-textures";
import { WorldStore } from "./store";
import { guardIceUdpSockets, prepareMdnsIceDescription } from "./rtc";
import { createDevMcpListener } from "./dev-mcp";
import { SpeechRateLimiter, speechVoiceForSessionToken } from "./speech";

type ClientData = {
  playerId: RuntimeId | null;
  sessionToken: string | null;
  socketGeneration: number;
  peerConnection: RTCPeerConnection | null;
  inputChannel: RTCDataChannel | null;
  stateChannel: RTCDataChannel | null;
  droppedStatePackets: number;
  rtcNegotiating: boolean;
};
type SessionRecord = {
  playerId: RuntimeId;
  socket: Bun.ServerWebSocket<ClientData> | null;
  socketGeneration: number;
  disconnectTimer: Timer | null;
};
let sourceSpeechWorker: Promise<Blob> | null = null;
const LINTALKER_SCRIPT_SHA256 = "6e25db22cdf4093cf281affbe5f140c7feec6b391663565ba9a00d86aee4264c";
const LINTALKER_WASM_SHA256 = "7f9c4522da11019ed54e81d634bd21edfded63ecebf1c509da5f5db11cc2925b";

export type GurgurServer = {
  port: number;
  devMcpUrl: string | null;
  metrics(): ServerMetrics;
  stop(): void;
};

export type ServerMetrics = ReturnType<AuthoritativeGame["metrics"]> & {
  worldEpoch: number;
  serverTick: number;
  connectedClients: number;
  backpressuredClients: number;
  queuedBytes: number;
  maxSnapshotAgeMs: number;
  stateTransportClients: number;
  droppedStatePackets: number;
};

const MAX_STATE_BUFFERED_BYTES = STATE_BACKPRESSURE_BYTES;
export async function createGurgurServer(
  options: {
    port?: number;
    hostname?: string;
    databasePath?: string;
    adminToken?: string;
    playerSpawn?: Vec3;
    publicOrigin?: string;
    extraDynamicBodies?: number;
    rtcAdditionalHostAddresses?: string[];
    rtcPortRange?: [number, number];
    rtcIceServers?: RTCIceServer[];
    worldBundle?: WorldBundle;
    devClientEnabled?: boolean;
    devMcpPort?: number;
  } = {},
): Promise<GurgurServer> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)
  ) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  if (Bun.env.NODE_ENV === "production" && options.devMcpPort !== undefined)
    throw new Error("dev MCP cannot be enabled in production");
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? null;
  if (publicOrigin && !URL.canParse(publicOrigin)) throw new Error("public origin is invalid");
  const serverHostname = options.hostname ?? process.env.HOST ?? "0.0.0.0";
  const rtcAdditionalHostAddresses = [
    ...(options.rtcAdditionalHostAddresses ??
      (process.env.RTC_ADDITIONAL_HOST_IPS ? process.env.RTC_ADDITIONAL_HOST_IPS.split(",") : [])),
  ];
  if (rtcAdditionalHostAddresses.some((address) => isIP(address) === 0))
    throw new Error("RTC_ADDITIONAL_HOST_IPS must contain comma-separated IP addresses");
  if (
    isIP(serverHostname) !== 0 &&
    serverHostname !== "0.0.0.0" &&
    serverHostname !== "::" &&
    !rtcAdditionalHostAddresses.includes(serverHostname)
  )
    rtcAdditionalHostAddresses.push(serverHostname);
  const rtcPortRange = options.rtcPortRange ?? readRtcPortRange();
  const rtcIceServers = options.rtcIceServers ?? readRtcIceServers();
  const adjacentWasm = Bun.file(new URL("./box3d.wasm", import.meta.url));
  const sourceWasm = Bun.file(
    new URL("../../../node_modules/box3d.js/dist/box3d.wasm", import.meta.url),
  );
  const box3dWasm = (await adjacentWasm.exists()) ? adjacentWasm : sourceWasm;
  const adjacentSpeechWorker = Bun.file(new URL("../../web/src/speech-worker.js", import.meta.url));
  const speechWorker = (await adjacentSpeechWorker.exists())
    ? adjacentSpeechWorker
    : await buildSourceSpeechWorker();
  const lintalkerScript = Bun.file(
    new URL("../../../third_party/lintalker/wintalker.js", import.meta.url),
  );
  const lintalkerWasm = Bun.file(
    new URL("../../../third_party/lintalker/wintalker.wasm", import.meta.url),
  );
  if (!(await lintalkerScript.exists()) || !(await lintalkerWasm.exists()))
    throw new Error("missing pinned LinTalker browser artifacts");
  const lintalkerScriptHash = await fileHash(lintalkerScript);
  const lintalkerWasmHash = await fileHash(lintalkerWasm);
  if (
    lintalkerScriptHash !== LINTALKER_SCRIPT_SHA256 ||
    lintalkerWasmHash !== LINTALKER_WASM_SHA256
  ) {
    throw new Error("pinned LinTalker browser artifact hash mismatch");
  }
  const playerBillboard = Bun.file(
    new URL("../../../content/generated/player-billboard/player-billboard.png", import.meta.url),
  );
  if (!(await playerBillboard.exists()))
    throw new Error("missing generated player billboard; run bun run render:player");
  const materialTextureRoot = new URL("../../../content/textures/", import.meta.url);
  const spriteRoot = new URL("../../../content/sprites/", import.meta.url);
  const audioRoot = new URL("../../../content/audio/", import.meta.url);
  const store = new WorldStore(
    options.databasePath ?? process.env.DATABASE_PATH ?? "./data/gurgur.sqlite",
  );
  const clients = new Set<Bun.ServerWebSocket<ClientData>>();
  const sessions = new Map<string, SessionRecord>();
  const speechRateLimiter = new SpeechRateLimiter();
  const devClientEnabled = Bun.env.NODE_ENV !== "production" && options.devClientEnabled !== false;
  let shuttingDown = false;
  const metrics = (): ServerMetrics => {
    const active = [...clients].filter((socket) => socket.data.playerId);
    return {
      ...game.metrics(),
      worldEpoch: game.worldEpoch,
      serverTick: game.serverTick,
      connectedClients: active.length,
      backpressuredClients: active.filter(
        (socket) => (socket.data.stateChannel?.bufferedAmount ?? 0) >= MAX_STATE_BUFFERED_BYTES,
      ).length,
      queuedBytes: active.reduce(
        (sum, socket) => sum + (socket.data.stateChannel?.bufferedAmount ?? 0),
        0,
      ),
      maxSnapshotAgeMs: 0,
      stateTransportClients: active.filter(
        (socket) => socket.data.stateChannel?.readyState === "open",
      ).length,
      droppedStatePackets: active.reduce((sum, socket) => sum + socket.data.droppedStatePackets, 0),
    };
  };

  const broadcast = (snapshot: Snapshot): void => {
    const packet = encodeSnapshot(snapshot);
    for (const socket of clients) {
      if (!socket.data.playerId) continue;
      const channel = socket.data.stateChannel;
      if (channel?.readyState !== "open") continue;
      if (channel.bufferedAmount >= MAX_STATE_BUFFERED_BYTES) {
        socket.data.droppedStatePackets += 1;
        continue;
      }
      try {
        channel.send(Buffer.from(packet));
      } catch {
        socket.close(1013, "state transport failed");
      }
    }
  };

  const broadcastLifecycle = (
    message: LifecycleMessage,
    except?: Bun.ServerWebSocket<ClientData>,
  ): void => {
    const packet = encodeLifecycle(message);
    for (const socket of clients)
      if (socket !== except && socket.data.playerId) socket.send(packet);
  };

  const broadcastWorld = (world: WorldMessage): void => {
    const message = JSON.stringify(toManifest(world));
    for (const socket of clients) if (socket.data.playerId) socket.send(message);
  };

  const game = await AuthoritativeGame.create(store, broadcast, broadcastWorld, {
    playerSpawn: options.playerSpawn,
    extraDynamicBodies: options.extraDynamicBodies,
    worldBundle: options.worldBundle,
  });
  const worldBundleBytes = encodeWorldBundle(game.worldMessage().bundle);
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "";
  let physicsDebugCache: { serverTick: number; body: string } | null = null;
  const physicsDebugResponse = (request: Request): Response => {
    if (new URL(request.url).searchParams.get("test") !== "1")
      return new Response("not found", { status: 404 });
    if (physicsDebugCache?.serverTick !== game.serverTick) {
      physicsDebugCache = {
        serverTick: game.serverTick,
        body: JSON.stringify(game.physicsDebugFrame()),
      };
    }
    return new Response(physicsDebugCache.body, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    });
  };
  const devUnavailable = (): Response => new Response("not found", { status: 404 });
  const devClientCapabilityResponse = (): Response =>
    devClientEnabled
      ? Response.json(
          { followCamera: true },
          {
            headers: { "cache-control": "no-store" },
          },
        )
      : devUnavailable();
  const acceptInputPacket = (
    socket: Bun.ServerWebSocket<ClientData>,
    packet: ArrayBuffer | ArrayBufferView,
  ): boolean => {
    let command: InputCommand;
    try {
      command = decodeInput(packet);
    } catch {
      return false;
    }
    if (!socket.data.playerId) return false;
    return validInputCommand(command) && game.acceptInput(socket.data.playerId, command);
  };
  const closeRtc = (socket: Bun.ServerWebSocket<ClientData>): void => {
    socket.data.inputChannel?.close();
    socket.data.stateChannel?.close();
    if (socket.data.peerConnection) void socket.data.peerConnection.close();
    socket.data.inputChannel = null;
    socket.data.stateChannel = null;
    socket.data.peerConnection = null;
    socket.data.rtcNegotiating = false;
  };
  const startRtcOffer = async (socket: Bun.ServerWebSocket<ClientData>): Promise<void> => {
    if (socket.data.rtcNegotiating) {
      socket.close(1008, "RTC negotiation already in progress");
      return;
    }
    closeRtc(socket);
    socket.data.rtcNegotiating = true;
    const peer = new RTCPeerConnection({
      iceUseIpv4: true,
      iceUseIpv6: false,
      iceServers: rtcIceServers,
      ...(rtcPortRange ? { icePortRange: rtcPortRange } : {}),
      ...(rtcAdditionalHostAddresses.length > 0
        ? { iceAdditionalHostAddresses: rtcAdditionalHostAddresses }
        : {}),
    });
    socket.data.peerConnection = peer;
    const stateChannel = peer.createDataChannel("gurgur-state-v4", {
      ordered: false,
      maxRetransmits: STATE_MAX_RETRANSMITS,
    });
    socket.data.stateChannel = stateChannel;
    stateChannel.stateChanged.subscribe((state) => {
      if (state !== "open" || socket.data.stateChannel !== stateChannel) return;
      const playerId = socket.data.playerId;
      if (!playerId) return;
      stateChannel.send(Buffer.from(encodeSnapshot(game.snapshot())));
    });
    peer.connectionStateChange.subscribe((state) => {
      if (socket.data.peerConnection === peer && state === "failed")
        socket.close(1013, "RTC connection failed");
    });
    peer.onDataChannel.subscribe((channel) => {
      if (socket.data.peerConnection !== peer) {
        channel.close();
        return;
      }
      if (channel.label === "gurgur-input-v4" && !socket.data.inputChannel) {
        socket.data.inputChannel = channel;
        channel.onMessage.subscribe((packet) => {
          if (typeof packet === "string" || !acceptInputPacket(socket, packet))
            socket.close(1007, "invalid input datagram");
        });
        return;
      }
      channel.close();
    });
    try {
      await peer.setLocalDescription(await peer.createOffer());
      guardIceUdpSockets(peer);
      if (socket.data.peerConnection !== peer || !peer.localDescription?.sdp) return;
      socket.send(
        JSON.stringify({
          type: "rtc-offer",
          protocolVersion: PROTOCOL_VERSION,
          worldEpoch: game.worldEpoch,
          description: { type: "offer", sdp: peer.localDescription.sdp },
          iceServers: rtcIceServers,
        }),
      );
    } catch {
      if (socket.data.peerConnection === peer) {
        closeRtc(socket);
        socket.close(1013, "RTC offer failed");
      }
    }
  };
  const acceptRtcAnswer = async (
    socket: Bun.ServerWebSocket<ClientData>,
    description: { type: "answer"; sdp: string },
  ): Promise<void> => {
    const peer = socket.data.peerConnection;
    if (!peer || !socket.data.rtcNegotiating || peer.signalingState !== "have-local-offer") {
      socket.close(1008, "unexpected RTC answer");
      return;
    }
    try {
      await peer.setRemoteDescription(prepareMdnsIceDescription(description));
      if (socket.data.peerConnection === peer) socket.data.rtcNegotiating = false;
    } catch {
      if (socket.data.peerConnection === peer) {
        closeRtc(socket);
        socket.close(1007, "invalid RTC answer");
      }
    }
  };
  const server = Bun.serve<ClientData>({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    hostname: serverHostname,
    routes: {
      "/": webApp,
      "/healthz": new Response("ok", {
        headers: { "content-type": "text/plain" },
      }),
      "/readyz": new Response("ready", {
        headers: { "content-type": "text/plain" },
      }),
      "/metrics": { GET: () => Response.json(metrics()) },
      "/debug/physics": { GET: physicsDebugResponse },
      "/debug/client-capabilities": { GET: devClientCapabilityResponse },
      "/box3d.wasm": new Response(box3dWasm, {
        headers: { "content-type": "application/wasm" },
      }),
      "/speech-worker.js": new Response(speechWorker, {
        headers: { "cache-control": "no-cache", "content-type": "text/javascript" },
      }),
      "/lintalker.js": {
        GET(request: Request) {
          const url = new URL(request.url);
          if (url.searchParams.get("v") !== lintalkerScriptHash) {
            url.search = "";
            url.searchParams.set("v", lintalkerScriptHash);
            return Response.redirect(url, 307);
          }
          return new Response(lintalkerScript, {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "text/javascript",
              etag: `"${lintalkerScriptHash}"`,
            },
          });
        },
      },
      "/lintalker.wasm": {
        GET(request: Request) {
          const url = new URL(request.url);
          if (url.searchParams.get("v") !== lintalkerWasmHash) {
            url.search = "";
            url.searchParams.set("v", lintalkerWasmHash);
            return Response.redirect(url, 307);
          }
          return new Response(lintalkerWasm, {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "application/wasm",
              etag: `"${lintalkerWasmHash}"`,
            },
          });
        },
      },
      "/player-billboard.png": new Response(playerBillboard, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
      "/assets.json": {
        async GET(request: Request) {
          const manifest = await loadAssetManifest(materialTextureRoot, spriteRoot, audioRoot);
          const etag = `"${createHash("sha256")
            .update(manifest.etag)
            .update(lintalkerScriptHash)
            .update(lintalkerWasmHash)
            .digest("hex")}"`;
          const headers = {
            "cache-control": "no-cache",
            "content-type": "application/json",
            etag,
          };
          if (request.headers.get("if-none-match") === etag) {
            return new Response(null, { status: 304, headers });
          }
          return Response.json(
            {
              materials: manifest.materials,
              sprites: manifest.sprites,
              audio: manifest.audio,
              speech: {
                workerUrl: "/speech-worker.js",
                scriptUrl: `/lintalker.js?v=${lintalkerScriptHash}`,
                wasmUrl: `/lintalker.wasm?v=${lintalkerWasmHash}`,
              },
            },
            { headers },
          );
        },
      },
      "/textures/*": {
        async GET(request: Request) {
          const url = new URL(request.url);
          const asset = await loadMaterialTextureAsset(materialTextureRoot, url.pathname);
          if (!asset) return new Response("texture not found", { status: 404 });
          if (url.searchParams.get("v") !== asset.hash) {
            url.search = "";
            url.searchParams.set("v", asset.hash);
            return Response.redirect(url, 307);
          }
          return new Response(asset.file, {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "image/png",
              etag: `"${asset.hash}"`,
            },
          });
        },
      },
      "/sprites/*": {
        async GET(request: Request) {
          const url = new URL(request.url);
          const asset = await loadSpriteAsset(spriteRoot, url.pathname);
          if (!asset) return new Response("sprite not found", { status: 404 });
          if (url.searchParams.get("v") !== asset.hash) {
            url.search = "";
            url.searchParams.set("v", asset.hash);
            return Response.redirect(url, 307);
          }
          return new Response(asset.file, {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "image/png",
              etag: `"${asset.hash}"`,
            },
          });
        },
      },
      "/audio/*": {
        async GET(request: Request) {
          const url = new URL(request.url);
          const asset = await loadAudioAsset(audioRoot, url.pathname);
          if (!asset) return new Response("audio not found", { status: 404 });
          if (url.searchParams.get("v") !== asset.hash) {
            url.search = "";
            url.searchParams.set("v", asset.hash);
            return Response.redirect(url, 307);
          }
          return new Response(asset.file, {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": "audio/mpeg",
              etag: `"${asset.hash}"`,
            },
          });
        },
      },
      "/favicon.ico": new Response(null, { status: 204 }),
      "/world.bin": {
        GET: () =>
          new Response(worldBundleBytes.slice(0), {
            headers: {
              "content-type": "application/octet-stream",
              "cache-control": "public, max-age=31536000, immutable",
              etag: `"${game.mapRevision}"`,
            },
          }),
      },
      "/admin/reset": {
        POST(request: Request) {
          if (!adminToken || request.headers.get("authorization") !== `Bearer ${adminToken}`) {
            return new Response("forbidden", { status: 403 });
          }
          return Response.json(game.reset());
        },
      },
      "/*": webApp,
    },
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/game") {
        if (publicOrigin && request.headers.get("origin") !== new URL(publicOrigin).origin) {
          return new Response("origin forbidden", { status: 403 });
        }
        if (
          bunServer.upgrade(request, {
            data: {
              playerId: null,
              sessionToken: null,
              socketGeneration: 0,
              peerConnection: null,
              inputChannel: null,
              stateChannel: null,
              droppedStatePackets: 0,
              rtcNegotiating: false,
            },
          })
        )
          return;
        return new Response("websocket upgrade required", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      perMessageDeflate: false,
      maxPayloadLength: 32_768,
      open(socket) {
        clients.add(socket);
      },
      message(socket, message) {
        if (typeof message === "string") {
          let control: ClientControlMessage;
          try {
            control = decodeClientControl(message);
          } catch {
            socket.close(1007, "invalid control packet");
            return;
          }
          if (control.type === "hello" && !socket.data.playerId) {
            if (
              control.protocolVersion !== PROTOCOL_VERSION ||
              (control.mapRevision !== null && control.mapRevision !== game.mapRevision) ||
              (control.worldEpoch !== null && control.worldEpoch !== game.worldEpoch) ||
              !Number.isSafeInteger(control.socketGeneration) ||
              control.socketGeneration < 0 ||
              (control.sessionToken !== null &&
                (control.sessionToken.length < 16 || control.sessionToken.length > 128))
            ) {
              socket.close(1002, "handshake mismatch");
              return;
            }
            let token = control.sessionToken;
            let session = token ? sessions.get(token) : undefined;
            let createdPlayer = false;
            if (token && !session) {
              const persistentId = persistentIdForToken(token);
              if (!game.canResumePlayer(persistentId)) {
                socket.close(1008, "unknown session");
                return;
              }
              session = {
                playerId: game.connectPlayer(persistentId),
                socket: null,
                socketGeneration: -1,
                disconnectTimer: null,
              };
              sessions.set(token, session);
              createdPlayer = true;
            }
            if (!session) {
              token = crypto.randomUUID();
              session = {
                playerId: game.connectPlayer(persistentIdForToken(token)),
                socket: null,
                socketGeneration: -1,
                disconnectTimer: null,
              };
              sessions.set(token, session);
              createdPlayer = true;
            }
            if (control.socketGeneration <= session.socketGeneration) {
              socket.close(1008, "stale socket generation");
              return;
            }
            if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
            const replaced = session.socket;
            session.socket = socket;
            session.socketGeneration = control.socketGeneration;
            socket.data.playerId = session.playerId;
            socket.data.sessionToken = token;
            socket.data.socketGeneration = control.socketGeneration;
            game.beginInputStream(session.playerId);
            if (replaced && replaced !== socket) replaced.close(4001, "replaced by reconnect");
            const welcome: WelcomeMessage = {
              type: "welcome",
              protocolVersion: PROTOCOL_VERSION,
              worldEpoch: game.worldEpoch,
              playerId: session.playerId,
              mapRevision: game.mapRevision,
              physicsHz: PHYSICS_HZ,
              snapshotHz: SNAPSHOT_HZ,
              sessionToken: token!,
              socketGeneration: control.socketGeneration,
            };
            socket.send(JSON.stringify(welcome));
            socket.send(JSON.stringify(toManifest(game.worldMessage())));
            void startRtcOffer(socket);
            if (createdPlayer) {
              const created = game
                .worldMessage()
                .runtimeEntities.find(
                  (entity) =>
                    entity.id.index === session!.playerId.index &&
                    entity.id.generation === session!.playerId.generation,
                );
              if (created)
                broadcastLifecycle(
                  {
                    type: "lifecycle",
                    protocolVersion: PROTOCOL_VERSION,
                    worldEpoch: game.worldEpoch,
                    created: [created],
                    removed: [],
                  },
                  socket,
                );
            }
            return;
          }
          if (control.type === "speak" && socket.data.playerId && socket.data.sessionToken) {
            if (control.worldEpoch !== game.worldEpoch) {
              const rejected: SpeechRejectedMessage = {
                type: "speech-rejected",
                protocolVersion: PROTOCOL_VERSION,
                worldEpoch: game.worldEpoch,
                requestId: control.requestId,
                reason: "world-changed",
                retryAfterMs: 0,
              };
              socket.send(JSON.stringify(rejected));
              return;
            }
            const limited = speechRateLimiter.accept(socket.data.sessionToken, performance.now());
            if (!limited.accepted) {
              const rejected: SpeechRejectedMessage = {
                type: "speech-rejected",
                protocolVersion: PROTOCOL_VERSION,
                worldEpoch: game.worldEpoch,
                requestId: control.requestId,
                reason: "rate-limited",
                retryAfterMs: limited.retryAfterMs,
              };
              socket.send(JSON.stringify(rejected));
              return;
            }
            const speech: SpeechMessage = {
              type: "speech",
              protocolVersion: PROTOCOL_VERSION,
              worldEpoch: game.worldEpoch,
              requestId: control.requestId,
              speakerId: socket.data.playerId,
              voice: speechVoiceForSessionToken(socket.data.sessionToken),
              text: control.text.trim(),
            };
            const encoded = JSON.stringify(speech);
            for (const client of clients) if (client.data.playerId) client.send(encoded);
            return;
          }
          if (
            control.type === "ping" &&
            control.protocolVersion === PROTOCOL_VERSION &&
            control.worldEpoch === game.worldEpoch &&
            Number.isSafeInteger(control.nonce) &&
            Number.isFinite(control.sentAtMs)
          ) {
            socket.send(
              JSON.stringify({
                type: "pong",
                protocolVersion: PROTOCOL_VERSION,
                worldEpoch: game.worldEpoch,
                nonce: control.nonce,
                sentAtMs: control.sentAtMs,
                serverTick: game.serverTick,
              }),
            );
            return;
          }
          if (
            control.type === "rtc-answer" &&
            socket.data.playerId &&
            control.worldEpoch === game.worldEpoch
          ) {
            void acceptRtcAnswer(socket, control.description);
            return;
          }
          socket.close(1007, "invalid control packet");
          return;
        }
        socket.close(1003, "binary WebSocket gameplay packets are unsupported");
      },
      close(socket) {
        clients.delete(socket);
        closeRtc(socket);
        const token = socket.data.sessionToken;
        const session = token ? sessions.get(token) : null;
        if (!session || session.socket !== socket) return;
        session.socket = null;
        if (shuttingDown) return;
        session.disconnectTimer = setTimeout(() => {
          if (session.socket || !sessions.delete(token!)) return;
          speechRateLimiter.forget(token!);
          if (game.disconnectPlayer(session.playerId))
            broadcastLifecycle({
              type: "lifecycle",
              protocolVersion: PROTOCOL_VERSION,
              worldEpoch: game.worldEpoch,
              created: [],
              removed: [session.playerId],
            });
        }, 10_000);
      },
    },
  });

  let devMcp: ReturnType<typeof createDevMcpListener> | null = null;
  if (options.devMcpPort !== undefined) {
    try {
      devMcp = createDevMcpListener({
        game,
        port: options.devMcpPort,
        connectedNetworkPlayers: () =>
          [...clients].flatMap((socket) => (socket.data.playerId ? [socket.data.playerId] : [])),
        created: (entity) =>
          broadcastLifecycle({
            type: "lifecycle",
            protocolVersion: PROTOCOL_VERSION,
            worldEpoch: game.worldEpoch,
            created: [entity],
            removed: [],
          }),
        removed: (id) =>
          broadcastLifecycle({
            type: "lifecycle",
            protocolVersion: PROTOCOL_VERSION,
            worldEpoch: game.worldEpoch,
            created: [],
            removed: [id],
          }),
      });
    } catch (error) {
      game.stop();
      store.close();
      server.stop(true);
      throw error;
    }
  }
  game.start();
  return {
    port: server.port ?? options.port ?? 3000,
    devMcpUrl: devMcp?.url ?? null,
    metrics,
    stop() {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const session of sessions.values())
        if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      for (const socket of clients) {
        closeRtc(socket);
        socket.close(1001, "server stopping");
      }
      devMcp?.stop();
      game.stop();
      store.close();
      server.stop(true);
    },
  };
}

function toManifest(world: WorldMessage): WorldManifestMessage {
  return {
    type: "world",
    protocolVersion: world.protocolVersion,
    worldEpoch: world.worldEpoch,
    mapRevision: world.bundle.mapRevision,
    bundleUrl: `/world.bin?revision=${encodeURIComponent(world.bundle.mapRevision)}`,
    runtimeEntities: world.runtimeEntities,
  };
}

function buildSourceSpeechWorker(): Promise<Blob> {
  sourceSpeechWorker ??= Bun.build({
    entrypoints: [new URL("../../web/src/speech-worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    minify: true,
  }).then((result) => {
    if (!result.success || !result.outputs[0])
      throw new Error("failed to build browser speech worker");
    return result.outputs[0];
  });
  return sourceSpeechWorker;
}

async function fileHash(file: Blob): Promise<string> {
  return createHash("sha256")
    .update(new Uint8Array(await file.arrayBuffer()))
    .digest("hex");
}

function validInputCommand(input: InputCommand): boolean {
  const finite = (value: number): boolean => Number.isFinite(value);
  if (
    input.type !== "input" ||
    input.protocolVersion !== PROTOCOL_VERSION ||
    !finite(input.moveX) ||
    !finite(input.moveZ) ||
    !finite(input.lookYaw) ||
    !finite(input.lookPitch) ||
    Math.abs(input.moveX) > 1.01 ||
    Math.abs(input.moveZ) > 1.01 ||
    Math.abs(input.lookYaw) > 1_000_000 ||
    Math.abs(input.lookPitch) > Math.PI / 2 + 0.01 ||
    (input.interactTarget !== null &&
      (!Number.isInteger(input.interactTarget.index) ||
        !Number.isInteger(input.interactTarget.generation) ||
        input.interactTarget.index < 0 ||
        input.interactTarget.generation < 0))
  )
    return false;
  return true;
}

function persistentIdForToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readRtcPortRange(): [number, number] | undefined {
  const minimumText = process.env.RTC_PORT_MIN;
  const maximumText = process.env.RTC_PORT_MAX;
  if (minimumText === undefined && maximumText === undefined) return undefined;
  const minimum = Number(minimumText);
  const maximum = Number(maximumText);
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 1 ||
    maximum > 65_535 ||
    minimum >= maximum
  )
    throw new Error("RTC_PORT_MIN and RTC_PORT_MAX must define an increasing UDP port range");
  return [minimum, maximum];
}

function readRtcIceServers(): RTCIceServer[] {
  const source = process.env.RTC_ICE_SERVERS_JSON;
  if (!source) return [];
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("RTC_ICE_SERVERS_JSON must be valid JSON");
  }
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some(
      (server) =>
        typeof server !== "object" ||
        server === null ||
        Array.isArray(server) ||
        typeof (server as { urls?: unknown }).urls !== "string" ||
        !/^(?:stun|stuns|turn|turns):/.test((server as { urls: string }).urls) ||
        ("username" in server && typeof server.username !== "string") ||
        ("credential" in server && typeof server.credential !== "string"),
    )
  )
    throw new Error("RTC_ICE_SERVERS_JSON must contain valid STUN or TURN server objects");
  return value as RTCIceServer[];
}
