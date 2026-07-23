import webApp from "../../web/index.html";
import { createHash } from "node:crypto";
import {
  PHYSICS_HZ,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  decodeInput,
  decodeClientControl,
  encodeLifecycle,
  encodeWorldBundle,
  encodeSnapshot,
  type InputCommand,
  type RuntimeId,
  type LifecycleMessage,
  type Snapshot,
  type Vec3,
  type WelcomeMessage,
  type ClientControlMessage,
  type WorldMessage,
  type WorldManifestMessage,
} from "@gurgur/shared";
import { AuthoritativeGame } from "./game";
import { WorldStore } from "./store";

type ClientData = {
  backpressured: boolean;
  playerId: RuntimeId | null;
  pendingSnapshot: ArrayBuffer | null;
  backpressureSinceMs: number;
  sessionToken: string | null;
  socketGeneration: number;
  pendingSnapshotAtMs: number;
  snapshotAgeMs: number;
  queuedBytes: number;
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
};

export async function createGurgurServer(
  options: {
    port?: number;
    hostname?: string;
    databasePath?: string;
    adminToken?: string;
    playerSpawn?: Vec3;
    publicOrigin?: string;
    extraDynamicBodies?: number;
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
      backpressuredClients: active.filter((socket) => socket.data.backpressured).length,
      queuedBytes: active.reduce((sum, socket) => sum + socket.data.queuedBytes, 0),
      maxSnapshotAgeMs: Math.max(0, ...active.map((socket) => socket.data.snapshotAgeMs)),
    };
  };

  const broadcast = (snapshot: Snapshot): void => {
    const packet = encodeSnapshot(snapshot);
    let completeReplacement: ArrayBuffer | null = null;
    const replacement = (): ArrayBuffer =>
      (completeReplacement ??= encodeSnapshot(
        game.snapshot({
          full: true,
          discontinuity: true,
        }),
      ));
    for (const socket of clients) {
      if (!socket.data.playerId) continue;
      if (socket.data.backpressured) {
        socket.data.pendingSnapshot = replacement();
        socket.data.pendingSnapshotAtMs = performance.now();
        socket.data.snapshotAgeMs = 0;
        socket.data.queuedBytes = socket.getBufferedAmount();
        if (performance.now() - socket.data.backpressureSinceMs >= 5_000) {
          socket.close(1013, "send queue made no progress");
        }
        continue;
      }
      const acceptedBytes = socket.send(packet);
      if (acceptedBytes < 0) {
        socket.data.backpressured = true;
        socket.data.pendingSnapshot = replacement();
        socket.data.backpressureSinceMs = performance.now();
        socket.data.pendingSnapshotAtMs = performance.now();
        socket.data.queuedBytes = socket.getBufferedAmount();
      } else {
        socket.data.queuedBytes = socket.getBufferedAmount();
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
  });
  const worldBundleBytes = encodeWorldBundle(game.worldMessage().bundle);
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "";
  const server = Bun.serve<ClientData>({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    hostname: options.hostname ?? process.env.HOST ?? "0.0.0.0",
    routes: {
      "/": webApp,
      "/healthz": new Response("ok", { headers: { "content-type": "text/plain" } }),
      "/readyz": new Response("ready", { headers: { "content-type": "text/plain" } }),
      "/metrics": { GET: () => Response.json(metrics()) },
      "/box3d.wasm": new Response(box3dWasm, { headers: { "content-type": "application/wasm" } }),
      "/prediction-worker.js": new Response(predictionWorker, {
        headers: { "content-type": "text/javascript" },
      }),
      "/player-billboard.png": new Response(playerBillboard, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
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
              backpressured: false,
              playerId: null,
              pendingSnapshot: null,
              backpressureSinceMs: 0,
              sessionToken: null,
              socketGeneration: 0,
              pendingSnapshotAtMs: 0,
              snapshotAgeMs: 0,
              queuedBytes: 0,
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
          socket.close(1007, "invalid control packet");
          return;
        }
        let command: InputCommand;
        try {
          command = decodeInput(message);
        } catch {
          socket.close(1007, "invalid input packet");
          return;
        }
        if (
          !validInputCommand(command) ||
          !socket.data.playerId ||
          !game.acceptInput(socket.data.playerId, command)
        ) {
          socket.close(1007, "invalid input command");
        }
      },
      drain(socket) {
        const pending = socket.data.pendingSnapshot;
        socket.data.snapshotAgeMs = pending
          ? performance.now() - socket.data.pendingSnapshotAtMs
          : 0;
        socket.data.pendingSnapshot = null;
        socket.data.backpressured = false;
        socket.data.backpressureSinceMs = 0;
        socket.data.queuedBytes = socket.getBufferedAmount();
        if (pending && socket.send(pending) < 0) {
          socket.data.pendingSnapshot = pending;
          socket.data.backpressured = true;
          socket.data.backpressureSinceMs = performance.now();
          socket.data.pendingSnapshotAtMs = performance.now();
          socket.data.queuedBytes = socket.getBufferedAmount();
        }
      },
      close(socket) {
        clients.delete(socket);
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
      for (const socket of clients) socket.close(1001, "server stopping");
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

function persistentIdForToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
