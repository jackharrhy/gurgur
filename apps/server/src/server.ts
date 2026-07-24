import webApp from "../../web/index.html";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { RTCPeerConnection, type RTCDataChannel, type RTCIceServer } from "werift";
import {
  FULL_RATE_BODY_RADIUS_METRES,
  PHYSICS_HZ,
  PROTOCOL_VERSION,
  SNAPSHOT_BODY_BYTES,
  SNAPSHOT_FLAG_CREATED,
  SNAPSHOT_HZ,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_INTERVAL_TICKS,
  SNAPSHOT_FLAG_LOCAL_GRAB,
  SNAPSHOT_FLAG_SLEEP,
  SNAPSHOT_FLAG_TELEPORT,
  SNAPSHOT_FLAG_WAKE,
  SNAPSHOT_PLAYER_BYTES,
  STATE_ALWAYS_NEAR_BODY_SLOTS,
  STATE_DATAGRAM_TARGET_BYTES,
  STATE_FAR_BODY_RESERVE,
  STATE_FAR_PLAYER_RESERVE,
  STATE_MAX_PLAYER_RECORDS,
  STATE_MAX_RETRANSMITS,
  decodeInputBundle,
  decodeClientControl,
  encodeLifecycle,
  encodeSnapshot,
  type InputCommand,
  type RuntimeId,
  type LifecycleMessage,
  type Snapshot,
  type Vec3,
  type WelcomeMessage,
  type ClientControlMessage,
  type WorldManifestMessage,
} from "@gurgur/engine";
import { encodeWorldBundle, type WorldBundle, type WorldMessage } from "@gurgur/game";
import { AuthoritativeGame } from "./game";
import { loadAssetManifest, loadMaterialTextureAsset, loadSpriteAsset } from "./material-textures";
import { WorldStore } from "./store";
import { guardIceUdpSockets, omitMdnsHostCandidates } from "./rtc";

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
let sourcePredictionWorker: Promise<Blob> | null = null;

export type GurgurServer = {
  port: number;
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

const MAX_STATE_BUFFERED_BYTES = STATE_DATAGRAM_TARGET_BYTES * 2;
const PRIORITY_BODY_FLAGS =
  SNAPSHOT_FLAG_CREATED |
  SNAPSHOT_FLAG_TELEPORT |
  SNAPSHOT_FLAG_WAKE |
  SNAPSHOT_FLAG_SLEEP |
  SNAPSHOT_FLAG_LOCAL_GRAB;

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
  } = {},
): Promise<GurgurServer> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)
  ) {
    throw new Error("port must be an integer between 0 and 65535");
  }
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
  const adjacentPredictionWorker = Bun.file(
    new URL("../../web/src/prediction-worker.js", import.meta.url),
  );
  const predictionWorker = (await adjacentPredictionWorker.exists())
    ? adjacentPredictionWorker
    : await buildSourcePredictionWorker();
  const playerBillboard = Bun.file(
    new URL("../../../content/generated/player-billboard/player-billboard.png", import.meta.url),
  );
  if (!(await playerBillboard.exists()))
    throw new Error("missing generated player billboard; run bun run render:player");
  const materialTextureRoot = new URL("../../../content/textures/", import.meta.url);
  const spriteRoot = new URL("../../../content/sprites/", import.meta.url);
  const store = new WorldStore(
    options.databasePath ?? process.env.DATABASE_PATH ?? "./data/gurgur.sqlite",
  );
  const clients = new Set<Bun.ServerWebSocket<ClientData>>();
  const sessions = new Map<string, SessionRecord>();
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
    for (const socket of clients) {
      const playerId = socket.data.playerId;
      if (!playerId) continue;
      const channel = socket.data.stateChannel;
      if (channel?.readyState !== "open") continue;
      if (channel.bufferedAmount >= MAX_STATE_BUFFERED_BYTES) {
        socket.data.droppedStatePackets += 1;
        continue;
      }
      try {
        channel.send(
          Buffer.from(
            encodeSnapshot(
              snapshotForPlayer(
                snapshot,
                game.playerPosition(playerId),
                playerId,
                game.grabbedTarget(playerId),
              ),
            ),
          ),
        );
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
  const acceptInputPacket = (
    socket: Bun.ServerWebSocket<ClientData>,
    packet: ArrayBuffer | ArrayBufferView,
  ): boolean => {
    let commands: InputCommand[];
    try {
      commands = decodeInputBundle(packet);
    } catch {
      return false;
    }
    if (!socket.data.playerId) return false;
    for (const command of commands) {
      if (!validInputCommand(command) || !game.acceptInput(socket.data.playerId, command))
        return false;
    }
    return true;
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
    const stateChannel = peer.createDataChannel("gurgur-state-v1", {
      ordered: false,
      maxRetransmits: STATE_MAX_RETRANSMITS,
    });
    socket.data.stateChannel = stateChannel;
    stateChannel.stateChanged.subscribe((state) => {
      if (state !== "open" || socket.data.stateChannel !== stateChannel) return;
      const playerId = socket.data.playerId;
      if (!playerId) return;
      stateChannel.send(
        Buffer.from(
          encodeSnapshot(
            snapshotForPlayer(
              game.snapshot({ full: true }),
              game.playerPosition(playerId),
              playerId,
              game.grabbedTarget(playerId),
            ),
          ),
        ),
      );
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
      if (channel.label === "gurgur-input-v1" && !socket.data.inputChannel) {
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
      await peer.setRemoteDescription(omitMdnsHostCandidates(description));
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
      "/box3d.wasm": new Response(box3dWasm, {
        headers: { "content-type": "application/wasm" },
      }),
      "/prediction-worker.js": new Response(predictionWorker, {
        headers: { "content-type": "text/javascript" },
      }),
      "/player-billboard.png": new Response(playerBillboard, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
      "/assets.json": {
        async GET(request: Request) {
          const manifest = await loadAssetManifest(materialTextureRoot, spriteRoot);
          const headers = {
            "cache-control": "no-cache",
            "content-type": "application/json",
            etag: manifest.etag,
          };
          if (request.headers.get("if-none-match") === manifest.etag) {
            return new Response(null, { status: 304, headers });
          }
          return Response.json(
            { materials: manifest.materials, sprites: manifest.sprites },
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
            socket.send(encodeSnapshot(game.snapshot()));
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
        if (!acceptInputPacket(socket, message)) {
          socket.close(1007, "invalid input packet");
        }
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

  game.start();
  return {
    port: server.port ?? options.port ?? 3000,
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

function buildSourcePredictionWorker(): Promise<Blob> {
  sourcePredictionWorker ??= Bun.build({
    entrypoints: [new URL("../../web/src/prediction-worker.ts", import.meta.url).pathname],
    target: "browser",
    minify: true,
  }).then((result) => {
    if (!result.success || !result.outputs[0])
      throw new Error("failed to build browser prediction worker");
    return result.outputs[0];
  });
  return sourcePredictionWorker;
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

export function snapshotForPlayer(
  snapshot: Snapshot,
  localPosition: Vec3 | null,
  localPlayerId: RuntimeId,
  localGrabbedTarget: RuntimeId | null = null,
): Snapshot {
  if (!localPosition) return snapshot;
  const playerSnapshot = localGrabbedTarget
    ? {
        ...snapshot,
        bodies: snapshot.bodies.map((body) =>
          body.id.index === localGrabbedTarget.index &&
          body.id.generation === localGrabbedTarget.generation
            ? { ...body, flags: (body.flags ?? 0) | SNAPSHOT_FLAG_LOCAL_GRAB }
            : body,
        ),
      }
    : snapshot;
  const rotation = Math.floor(playerSnapshot.serverTick / SNAPSHOT_INTERVAL_TICKS);
  const playerIds = new Set(playerSnapshot.players.map(({ id }) => `${id.index}:${id.generation}`));
  // Distant players are interest-managed too; at 32 peers, including every
  // player would consume the entire state-datagram budget before any prop.
  const orderedPlayers = playerSnapshot.players.toSorted((left, right) => {
    const leftIsLocal =
      left.id.index === localPlayerId.index && left.id.generation === localPlayerId.generation;
    const rightIsLocal =
      right.id.index === localPlayerId.index && right.id.generation === localPlayerId.generation;
    if (leftIsLocal !== rightIsLocal) return leftIsLocal ? -1 : 1;
    return (
      Math.hypot(
        left.position.x - localPosition.x,
        left.position.y - localPosition.y,
        left.position.z - localPosition.z,
      ) -
      Math.hypot(
        right.position.x - localPosition.x,
        right.position.y - localPosition.y,
        right.position.z - localPosition.z,
      )
    );
  });
  const selectedPlayers =
    orderedPlayers.length <= STATE_MAX_PLAYER_RECORDS
      ? orderedPlayers
      : [
          ...orderedPlayers.slice(0, STATE_MAX_PLAYER_RECORDS - STATE_FAR_PLAYER_RESERVE),
          ...takeRotating(
            orderedPlayers.slice(STATE_MAX_PLAYER_RECORDS - STATE_FAR_PLAYER_RESERVE),
            STATE_FAR_PLAYER_RESERVE,
            rotation,
          ),
        ];
  const selectedPlayerIds = new Set(
    selectedPlayers.map(({ id }) => `${id.index}:${id.generation}`),
  );
  const selectedPlayerBodies = playerSnapshot.bodies.filter((body) =>
    selectedPlayerIds.has(`${body.id.index}:${body.id.generation}`),
  );
  const bodyCapacity = Math.max(
    0,
    Math.floor(
      (STATE_DATAGRAM_TARGET_BYTES -
        SNAPSHOT_HEADER_BYTES -
        selectedPlayers.length * SNAPSHOT_PLAYER_BYTES) /
        SNAPSHOT_BODY_BYTES,
    ),
  );
  const candidates = playerSnapshot.bodies
    .filter((body) => !playerIds.has(`${body.id.index}:${body.id.generation}`))
    .map((body) => ({
      body,
      distance: Math.hypot(
        body.position.x - localPosition.x,
        body.position.y - localPosition.y,
        body.position.z - localPosition.z,
      ),
    }));
  if (candidates.length <= bodyCapacity)
    return {
      ...playerSnapshot,
      players: selectedPlayers,
      bodies: [...selectedPlayerBodies, ...candidates.map(({ body }) => body)],
    };

  const urgent = candidates.filter(({ body }) => ((body.flags ?? 0) & PRIORITY_BODY_FLAGS) !== 0);
  const ordinary = candidates.filter(({ body }) => ((body.flags ?? 0) & PRIORITY_BODY_FLAGS) === 0);
  const near = ordinary
    .filter(({ distance }) => distance <= FULL_RATE_BODY_RADIUS_METRES)
    .toSorted((left, right) => left.distance - right.distance);
  const far = ordinary
    .filter(({ distance }) => distance > FULL_RATE_BODY_RADIUS_METRES)
    .toSorted((left, right) => left.distance - right.distance);
  const selected = takeRotating(urgent, bodyCapacity, rotation);
  let remaining = bodyCapacity - selected.length;
  const farReserve = Math.min(STATE_FAR_BODY_RESERVE, far.length, remaining);
  const alwaysNearCount = Math.min(
    STATE_ALWAYS_NEAR_BODY_SLOTS,
    near.length,
    remaining - farReserve,
  );
  selected.push(...near.slice(0, alwaysNearCount));
  remaining -= alwaysNearCount;
  const rotatingNear = near.slice(alwaysNearCount);
  const selectedNear = takeRotating(
    rotatingNear,
    Math.min(rotatingNear.length, remaining - farReserve),
    rotation,
  );
  selected.push(...selectedNear);
  remaining -= selectedNear.length;
  const selectedFar = takeRotating(far, remaining, rotation);
  selected.push(...selectedFar);
  remaining -= selectedFar.length;
  if (remaining > 0) {
    const selectedKeys = new Set(
      selected.map(({ body }) => `${body.id.index}:${body.id.generation}`),
    );
    selected.push(
      ...takeRotating(
        rotatingNear.filter(
          ({ body }) => !selectedKeys.has(`${body.id.index}:${body.id.generation}`),
        ),
        remaining,
        rotation + 1,
      ),
    );
  }
  return {
    ...playerSnapshot,
    players: selectedPlayers,
    bodies: [...selectedPlayerBodies, ...selected.map(({ body }) => body)],
  };
}

function takeRotating<T>(items: T[], count: number, rotation: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (count >= items.length) return [...items];
  const start = (rotation * count) % items.length;
  return Array.from({ length: count }, (_, index) => items[(start + index) % items.length]!);
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
