import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION, SNAPSHOT_TAG, decodeSnapshot, decodeWorldBundle, encodeInput,
  type Snapshot, type WelcomeMessage, type WorldManifestMessage,
} from "@gurgur/shared";
import { createGurgurServer } from "../src/server";

describe("authoritative server", () => {
  test("serves health and streams advancing binary snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-server-"));
    const server = await createGurgurServer({
      port: 0,
      hostname: "127.0.0.1",
      databasePath: join(directory, "world.sqlite"),
    });
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).text()).toBe("ok");
      expect(await (await fetch(`http://127.0.0.1:${server.port}/readyz`)).text()).toBe("ready");
      expect((await fetch(`http://127.0.0.1:${server.port}/some/client/route`)).headers.get("content-type")).toContain("text/html");
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/game`);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        type: "hello", protocolVersion: PROTOCOL_VERSION, mapRevision: null, worldEpoch: null,
        sessionToken: null, socketGeneration: 0,
      })));
      const messages = await new Promise<Array<WelcomeMessage | WorldManifestMessage | Snapshot>>((resolve, reject) => {
        const received: Array<WelcomeMessage | WorldManifestMessage | Snapshot> = [];
        const timeout = setTimeout(() => reject(new Error("timed out waiting for snapshots")), 3_000);
        socket.addEventListener("message", (event) => {
          received.push(typeof event.data === "string"
            ? JSON.parse(event.data) as WelcomeMessage
            : decodeSnapshot(event.data as ArrayBuffer));
          if (received.length >= 4) {
            clearTimeout(timeout);
            resolve(received);
          }
        });
        socket.addEventListener("error", () => reject(new Error("websocket failed")));
      });
      socket.close();
      const welcome = messages[0] as WelcomeMessage;
      const world = messages[1] as WorldManifestMessage;
      const bundle = decodeWorldBundle(await (await fetch(`http://127.0.0.1:${server.port}${world.bundleUrl}`)).arrayBuffer());
      const initial = messages[2] as Snapshot;
      const advanced = messages[3] as Snapshot;
      expect(welcome.type).toBe("welcome");
      expect(welcome.playerId.index).toBeGreaterThan(0x7fff_ffff);
      expect(world.type).toBe("world");
      expect(world.bundleUrl).toBe(`/world.bin?revision=${encodeURIComponent(world.mapRevision)}`);
      expect(bundle.brushes.length).toBe(32);
      expect(world.runtimeEntities.length).toBe(11);
      expect(world.runtimeEntities.some((entity) => entity.classname === "player")).toBe(true);
      expect(initial.serverTick).toBeLessThan(advanced.serverTick);
      expect(initial.bodies[0]?.position.y).toBeGreaterThan(advanced.bodies[0]?.position.y ?? Infinity);
      const metrics = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).json() as ReturnType<typeof server.metrics>;
      expect(metrics.serverTick).toBeGreaterThan(0);
      expect(metrics.tickP99Ms).toBeGreaterThanOrEqual(0);
      expect(metrics.queuedBytes).toBeGreaterThanOrEqual(0);
    } finally {
      server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("gives sixteen concurrent clients unique authoritative players", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-players-"));
    const server = await createGurgurServer({
      port: 0,
      hostname: "127.0.0.1",
      databasePath: join(directory, "world.sqlite"),
    });
    const sockets: WebSocket[] = [];
    try {
      const connections = [];
      for (let index = 0; index < 16; index += 1) {
        const connection = await connectClient(`ws://127.0.0.1:${server.port}/game`);
        sockets.push(connection.socket);
        connections.push(connection);
      }
      const ids = new Set(connections.map(({ welcome }) => `${welcome.playerId.index}:${welcome.playerId.generation}`));
      expect(ids.size).toBe(16);
      expect(connections.at(-1)!.world.runtimeEntities.filter((entity) => entity.classname === "player").length).toBe(16);
    } finally {
      for (const socket of sockets) socket.close();
      server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reconnects a server-issued session onto the same player and rejects stale socket generations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-reconnect-"));
    const server = await createGurgurServer({ port: 0, hostname: "127.0.0.1", databasePath: join(directory, "world.sqlite") });
    try {
      const url = `ws://127.0.0.1:${server.port}/game`;
      const first = await connectClient(url);
      const replaced = new Promise<CloseEvent>((resolve) => first.socket.addEventListener("close", resolve, { once: true }));
      const second = await connectClient(url, first.welcome.sessionToken, 1, first.welcome.mapRevision, first.welcome.worldEpoch);
      expect(second.welcome.playerId).toEqual(first.welcome.playerId);
      expect((await replaced).code).toBe(4001);
      expect(second.world.runtimeEntities.filter((entity) => entity.classname === "player").length).toBe(1);

      const stale = new WebSocket(url);
      const closed = new Promise<CloseEvent>((resolve) => stale.addEventListener("close", resolve, { once: true }));
      stale.addEventListener("open", () => stale.send(JSON.stringify({
        type: "hello", protocolVersion: PROTOCOL_VERSION,
        mapRevision: first.welcome.mapRevision, worldEpoch: first.welcome.worldEpoch,
        sessionToken: first.welcome.sessionToken, socketGeneration: 1,
      })));
      expect((await closed).code).toBe(1008);
      second.socket.close();
    } finally {
      server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("resumes the same private session position across a complete server process lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-process-resume-"));
    const databasePath = join(directory, "world.sqlite");
    let firstServer = await createGurgurServer({ port: 0, hostname: "127.0.0.1", databasePath });
    let first: Awaited<ReturnType<typeof connectClient>> | null = null;
    try {
      first = await connectClient(`ws://127.0.0.1:${firstServer.port}/game`);
      const movedSnapshot = waitForSnapshot(first.socket, (snapshot) => snapshot.serverTick >= first!.snapshot.serverTick + 12);
      for (let sequence = 0; sequence < 20; sequence += 1) first.socket.send(encodeInput({
        type: "input", protocolVersion: PROTOCOL_VERSION, worldEpoch: first.welcome.worldEpoch,
        sequence, clientTick: sequence, moveX: 1, moveZ: 0, lookYaw: 0, lookPitch: 0,
        buttons: 0, jumpCounter: 0, interactCounter: 0, primaryCounter: 0, interactTarget: null,
      }));
      const moved = await movedSnapshot;
      const movedPlayer = moved.players.find((player) => player.id.index === first!.welcome.playerId.index)!;
      first.socket.close();
      firstServer.stop();

      const secondServer = await createGurgurServer({ port: 0, hostname: "127.0.0.1", databasePath });
      try {
        const resumed = await connectClient(
          `ws://127.0.0.1:${secondServer.port}/game`, first.welcome.sessionToken, 1,
          first.welcome.mapRevision, first.welcome.worldEpoch,
        );
        const resumedPlayer = resumed.snapshot.players.find((player) => player.id.index === resumed.welcome.playerId.index)!;
        expect(resumedPlayer.position.x).toBeWithin(movedPlayer.position.x - 0.15, movedPlayer.position.x + 0.15);
        expect(resumedPlayer.position.z).toBeWithin(movedPlayer.position.z - 0.15, movedPlayer.position.z + 0.15);
        resumed.socket.close();
      } finally {
        secondServer.stop();
      }
    } finally {
      first?.socket.close();
      firstServer.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("resets connected clients onto a new epoch with no old runtime handles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-connected-reset-"));
    const server = await createGurgurServer({
      port: 0, hostname: "127.0.0.1", databasePath: join(directory, "world.sqlite"), adminToken: "reset-test-token",
    });
    try {
      const client = await connectClient(`ws://127.0.0.1:${server.port}/game`);
      const oldIds = new Set(client.world.runtimeEntities
        .filter((entity) => entity.classname !== "player")
        .map((entity) => `${entity.id.index}:${entity.id.generation}`));
      const resetWorld = waitForJson(client.socket, "world", (message) => message.worldEpoch === client.welcome.worldEpoch + 1);
      const resetSnapshot = waitForSnapshot(client.socket, (snapshot) => snapshot.worldEpoch === client.welcome.worldEpoch + 1);
      const response = await fetch(`http://127.0.0.1:${server.port}/admin/reset`, {
        method: "POST", headers: { authorization: "Bearer reset-test-token" },
      });
      expect(response.ok).toBe(true);
      const [world, snapshot] = await Promise.all([resetWorld, resetSnapshot]);
      expect(world.runtimeEntities
        .filter((entity: { classname: string }) => entity.classname !== "player")
        .every((entity: { id: { index: number; generation: number } }) =>
          !oldIds.has(`${entity.id.index}:${entity.id.generation}`))).toBe(true);
      expect(snapshot.worldEpoch).toBe(client.welcome.worldEpoch + 1);
      client.socket.close();
    } finally {
      server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("builds a symmetric six-peer voice graph and revokes blocked signaling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-voice-"));
    const server = await createGurgurServer({
      port: 0, hostname: "127.0.0.1", databasePath: join(directory, "world.sqlite"),
      voiceRelayOnly: true, voiceIceServers: [{ urls: "turn:relay.test", username: "user", credential: "secret" }],
    });
    const connections: Awaited<ReturnType<typeof connectClient>>[] = [];
    try {
      const url = `ws://127.0.0.1:${server.port}/game`;
      for (let index = 0; index < 8; index += 1) connections.push(await connectClient(url));
      expect(connections[0]!.welcome.voiceConfig).toEqual({
        iceTransportPolicy: "relay",
        iceServers: [{ urls: "turn:relay.test", username: "user", credential: "secret" }],
      });
      for (const connection of connections) connection.socket.send(JSON.stringify({
        type: "voice-ready", protocolVersion: PROTOCOL_VERSION,
        worldEpoch: connection.welcome.worldEpoch, enabled: true,
      }));
      await Bun.sleep(10);
      const peerUpdates = connections.map((connection) => waitForJson(connection.socket, "voice-peers", (message) =>
        Array.isArray(message.peers) && message.peers.length >= 1,
      ));
      connections[0]!.socket.send(JSON.stringify({
        type: "voice-ready", protocolVersion: PROTOCOL_VERSION,
        worldEpoch: connections[0]!.welcome.worldEpoch, enabled: true,
      }));
      const graphs = await Promise.all(peerUpdates);
      expect(graphs.every((graph) => graph.peers.length <= 6)).toBe(true);
      for (let index = 0; index < connections.length; index += 1) {
        for (const peer of graphs[index]!.peers) {
          const reciprocal = graphs.find((_, candidate) => connections[candidate]!.welcome.peerId === peer.peerId)!;
          expect(reciprocal.peers.some((candidate: { peerId: string }) => candidate.peerId === connections[index]!.welcome.peerId)).toBe(true);
        }
      }

      const firstPeerId = graphs[0]!.peers[0]!.peerId as string;
      const secondIndex = connections.findIndex((connection) => connection.welcome.peerId === firstPeerId);
      const forwarded = waitForJson(connections[secondIndex]!.socket, "voice-signal", (message) =>
        message.fromPeerId === connections[0]!.welcome.peerId,
      );
      connections[0]!.socket.send(JSON.stringify({
        type: "voice-signal", protocolVersion: PROTOCOL_VERSION, worldEpoch: connections[0]!.welcome.worldEpoch,
        toPeerId: firstPeerId, signal: { candidate: { candidate: "candidate:test" } },
      }));
      expect((await forwarded).signal.candidate.candidate).toBe("candidate:test");

      const revokedA = waitForJson(connections[0]!.socket, "voice-peers", (message) =>
        !message.peers.some((peer: { peerId: string }) => peer.peerId === firstPeerId),
      );
      const revokedB = waitForJson(connections[secondIndex]!.socket, "voice-peers", (message) =>
        !message.peers.some((peer: { peerId: string }) => peer.peerId === connections[0]!.welcome.peerId),
      );
      connections[secondIndex]!.socket.send(JSON.stringify({
        type: "voice-block", protocolVersion: PROTOCOL_VERSION,
        worldEpoch: connections[secondIndex]!.welcome.worldEpoch,
        peerId: connections[0]!.welcome.peerId, blocked: true,
      }));
      await Promise.all([revokedA, revokedB]);
    } finally {
      for (const connection of connections) connection.socket.close();
      server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function connectClient(
  url: string,
  sessionToken: string | null = null,
  socketGeneration = 0,
  mapRevision: string | null = null,
  worldEpoch: number | null = null,
): Promise<{ socket: WebSocket; welcome: WelcomeMessage; world: WorldManifestMessage; snapshot: Snapshot }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let welcome: WelcomeMessage | null = null;
    let world: WorldManifestMessage | null = null;
    let snapshot: Snapshot | null = null;
    const done = (): void => {
      if (!welcome || !world || !snapshot) return;
      clearTimeout(timeout);
      resolve({ socket, welcome, world, snapshot });
    };
    const timeout = setTimeout(() => reject(new Error("timed out connecting test client")), 3_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "hello", protocolVersion: PROTOCOL_VERSION, mapRevision, worldEpoch,
      sessionToken, socketGeneration,
    })));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        if (new Uint8Array(event.data as ArrayBuffer)[0] !== SNAPSHOT_TAG) return;
        snapshot = decodeSnapshot(event.data as ArrayBuffer);
        done();
        return;
      }
      const message = JSON.parse(event.data) as WelcomeMessage | WorldManifestMessage;
      if (message.type === "welcome") welcome = message;
      if (message.type === "world") world = message;
      done();
    });
    socket.addEventListener("error", () => reject(new Error("test client websocket failed")));
  });
}

function waitForSnapshot(socket: WebSocket, predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error("timed out waiting for snapshot"));
    }, 3_000);
    const listener = (event: MessageEvent): void => {
      if (typeof event.data === "string") return;
      if (new Uint8Array(event.data as ArrayBuffer)[0] !== SNAPSHOT_TAG) return;
      const snapshot = decodeSnapshot(event.data as ArrayBuffer);
      if (!predicate(snapshot)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(snapshot);
    };
    socket.addEventListener("message", listener);
  });
}

function waitForJson(
  socket: WebSocket,
  type: string,
  predicate: (message: any) => boolean = () => true,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error(`timed out waiting for ${type}`));
    }, 3_000);
    const listener = (event: MessageEvent): void => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(message);
    };
    socket.addEventListener("message", listener);
  });
}
