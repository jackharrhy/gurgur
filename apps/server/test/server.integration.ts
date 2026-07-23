import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import {
  PROTOCOL_VERSION,
  SNAPSHOT_TAG,
  STATE_DATAGRAM_TARGET_BYTES,
  STATE_MAX_RETRANSMITS,
  decodeSnapshot,
  decodeWorldBundle,
  encodeInput,
  encodeSnapshot,
  type Snapshot,
  type WelcomeMessage,
  type WorldManifestMessage,
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
      const playerBillboard = await fetch(`http://127.0.0.1:${server.port}/player-billboard.png`);
      expect(playerBillboard.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await playerBillboard.arrayBuffer()).slice(0, 8)).toEqual(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      const textureManifestResponse = await fetch(`http://127.0.0.1:${server.port}/textures.json`);
      expect(textureManifestResponse.headers.get("cache-control")).toBe("no-cache");
      const textureManifest = (await textureManifestResponse.json()) as Record<string, string>;
      expect(textureManifest["GURGUR/CONCRETE"]).toMatch(
        /^\/textures\/GURGUR\/CONCRETE\.png\?v=[0-9a-f]{64}$/,
      );
      const concreteTexture = await fetch(
        `http://127.0.0.1:${server.port}${textureManifest["GURGUR/CONCRETE"]}`,
      );
      expect(concreteTexture.headers.get("content-type")).toBe("image/png");
      expect(concreteTexture.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(new Uint8Array(await concreteTexture.arrayBuffer()).slice(0, 8)).toEqual(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(
        (await fetch(`http://127.0.0.1:${server.port}/some/client/route`)).headers.get(
          "content-type",
        ),
      ).toContain("text/html");
      const client = await connectClient(`ws://127.0.0.1:${server.port}/game`);
      expect(client.stateChannel.maxRetransmits).toBe(STATE_MAX_RETRANSMITS);
      const advanced = await waitForSnapshot(
        client.stateChannel,
        (snapshot) => snapshot.serverTick > client.snapshot.serverTick,
      );
      client.socket.close();
      const welcome = client.welcome;
      const world = client.world;
      const bundle = decodeWorldBundle(
        await (await fetch(`http://127.0.0.1:${server.port}${world.bundleUrl}`)).arrayBuffer(),
      );
      const initial = client.snapshot;
      expect(welcome.type).toBe("welcome");
      expect(welcome.playerId.index).toBeGreaterThan(0x7fff_ffff);
      expect(world.type).toBe("world");
      expect(world.bundleUrl).toBe(`/world.bin?revision=${encodeURIComponent(world.mapRevision)}`);
      expect(bundle.staticCollision.triangles.length).toBeGreaterThan(0);
      const authoredRuntimeCount = bundle.entities.filter((entity) =>
        ["func_physics", "func_door", "func_platform", "func_button"].includes(entity.classname),
      ).length;
      expect(world.runtimeEntities).toHaveLength(authoredRuntimeCount + 1);
      expect(world.runtimeEntities.some((entity) => entity.classname === "player")).toBe(true);
      expect(initial.serverTick).toBeLessThan(advanced.serverTick);
      expect(
        advanced.bodies.some((body) => {
          const before = initial.bodies.find(
            (candidate) =>
              candidate.id.index === body.id.index &&
              candidate.id.generation === body.id.generation,
          );
          return (
            before !== undefined &&
            Math.hypot(
              body.position.x - before.position.x,
              body.position.y - before.position.y,
              body.position.z - before.position.z,
            ) > 1e-6
          );
        }),
      ).toBe(true);
      const metrics = (await (
        await fetch(`http://127.0.0.1:${server.port}/metrics`)
      ).json()) as ReturnType<typeof server.metrics>;
      expect(metrics.serverTick).toBeGreaterThan(0);
      expect(metrics.tickP99Ms).toBeGreaterThanOrEqual(0);
      expect(metrics.queuedBytes).toBeGreaterThanOrEqual(0);
      expect(metrics.stateTransportClients).toBeGreaterThanOrEqual(0);
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
      extraDynamicBodies: 122,
    });
    const sockets: WebSocket[] = [];
    try {
      const connections = [];
      for (let index = 0; index < 16; index += 1) {
        const connection = await connectClient(`ws://127.0.0.1:${server.port}/game`);
        sockets.push(connection.socket);
        connections.push(connection);
      }
      const ids = new Set(
        connections.map(
          ({ welcome }) => `${welcome.playerId.index}:${welcome.playerId.generation}`,
        ),
      );
      expect(ids.size).toBe(16);
      expect(
        connections.at(-1)!.world.runtimeEntities.filter((entity) => entity.classname === "player")
          .length,
      ).toBe(16);
      const newest = connections.at(-1)!;
      const state = await waitForSnapshot(
        newest.stateChannel,
        (snapshot) => snapshot.serverTick > newest.snapshot.serverTick,
      );
      expect(encodeSnapshot(state).byteLength).toBeLessThanOrEqual(STATE_DATAGRAM_TARGET_BYTES);
    } finally {
      for (const socket of sockets) socket.close();
      server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reconnects a server-issued session onto the same player and rejects stale socket generations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-reconnect-"));
    const server = await createGurgurServer({
      port: 0,
      hostname: "127.0.0.1",
      databasePath: join(directory, "world.sqlite"),
    });
    try {
      const url = `ws://127.0.0.1:${server.port}/game`;
      const first = await connectClient(url);
      const replaced = new Promise<CloseEvent>((resolve) =>
        first.socket.addEventListener("close", resolve, { once: true }),
      );
      const second = await connectClient(
        url,
        first.welcome.sessionToken,
        1,
        first.welcome.mapRevision,
        first.welcome.worldEpoch,
      );
      expect(second.welcome.playerId).toEqual(first.welcome.playerId);
      expect((await replaced).code).toBe(4001);
      expect(
        second.world.runtimeEntities.filter((entity) => entity.classname === "player").length,
      ).toBe(1);

      const stale = new WebSocket(url);
      const closed = new Promise<CloseEvent>((resolve) =>
        stale.addEventListener("close", resolve, { once: true }),
      );
      stale.addEventListener("open", () =>
        stale.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            mapRevision: first.welcome.mapRevision,
            worldEpoch: first.welcome.worldEpoch,
            sessionToken: first.welcome.sessionToken,
            socketGeneration: 1,
          }),
        ),
      );
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
    let firstServer = await createGurgurServer({
      port: 0,
      hostname: "127.0.0.1",
      databasePath,
    });
    let first: Awaited<ReturnType<typeof connectClient>> | null = null;
    try {
      first = await connectClient(`ws://127.0.0.1:${firstServer.port}/game`);
      const movedSnapshot = waitForSnapshot(
        first.stateChannel,
        (snapshot) => snapshot.serverTick >= first!.snapshot.serverTick + 12,
      );
      for (let sequence = 0; sequence < 20; sequence += 1)
        first.inputChannel.send(
          Buffer.from(
            encodeInput({
              type: "input",
              protocolVersion: PROTOCOL_VERSION,
              worldEpoch: first.welcome.worldEpoch,
              sequence,
              clientTick: sequence,
              moveX: 1,
              moveZ: 0,
              lookYaw: 0,
              lookPitch: 0,
              buttons: 0,
              jumpCounter: 0,
              interactCounter: 0,
              primaryCounter: 0,
              interactTarget: null,
            }),
          ),
        );
      const moved = await movedSnapshot;
      const movedPlayer = moved.players.find(
        (player) => player.id.index === first!.welcome.playerId.index,
      )!;
      first.socket.close();
      firstServer.stop();

      const secondServer = await createGurgurServer({
        port: 0,
        hostname: "127.0.0.1",
        databasePath,
      });
      try {
        const resumed = await connectClient(
          `ws://127.0.0.1:${secondServer.port}/game`,
          first.welcome.sessionToken,
          1,
          first.welcome.mapRevision,
          first.welcome.worldEpoch,
        );
        const resumedPlayer = resumed.snapshot.players.find(
          (player) => player.id.index === resumed.welcome.playerId.index,
        )!;
        expect(resumedPlayer.position.x).toBeWithin(
          movedPlayer.position.x - 0.15,
          movedPlayer.position.x + 0.15,
        );
        expect(resumedPlayer.position.z).toBeWithin(
          movedPlayer.position.z - 0.15,
          movedPlayer.position.z + 0.15,
        );
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
      port: 0,
      hostname: "127.0.0.1",
      databasePath: join(directory, "world.sqlite"),
      adminToken: "reset-test-token",
    });
    try {
      const client = await connectClient(`ws://127.0.0.1:${server.port}/game`);
      const oldIds = new Set(
        client.world.runtimeEntities
          .filter((entity) => entity.classname !== "player")
          .map((entity) => `${entity.id.index}:${entity.id.generation}`),
      );
      const resetWorld = waitForJson(
        client.socket,
        "world",
        (message) => message.worldEpoch === client.welcome.worldEpoch + 1,
      );
      const resetSnapshot = waitForSnapshot(
        client.stateChannel,
        (snapshot) => snapshot.worldEpoch === client.welcome.worldEpoch + 1,
      );
      const response = await fetch(`http://127.0.0.1:${server.port}/admin/reset`, {
        method: "POST",
        headers: { authorization: "Bearer reset-test-token" },
      });
      expect(response.ok).toBe(true);
      const [world, snapshot] = await Promise.all([resetWorld, resetSnapshot]);
      expect(
        world.runtimeEntities
          .filter((entity: { classname: string }) => entity.classname !== "player")
          .every(
            (entity: { id: { index: number; generation: number } }) =>
              !oldIds.has(`${entity.id.index}:${entity.id.generation}`),
          ),
      ).toBe(true);
      expect(snapshot.worldEpoch).toBe(client.welcome.worldEpoch + 1);
      client.socket.close();
    } finally {
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
): Promise<{
  socket: WebSocket;
  peer: RTCPeerConnection;
  inputChannel: RTCDataChannel;
  stateChannel: RTCDataChannel;
  welcome: WelcomeMessage;
  world: WorldManifestMessage;
  snapshot: Snapshot;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const peer = new RTCPeerConnection({
      iceAdditionalHostAddresses: ["127.0.0.1"],
    });
    const inputChannel = peer.createDataChannel("gurgur-input-v2", {
      ordered: false,
      maxRetransmits: 0,
    });
    let stateChannel: RTCDataChannel | null = null;
    let welcome: WelcomeMessage | null = null;
    let world: WorldManifestMessage | null = null;
    let snapshot: Snapshot | null = null;
    let stateReady = false;
    let offerStarted = false;
    const done = (): void => {
      if (!welcome || !world || !snapshot || !stateReady || !stateChannel) return;
      clearTimeout(timeout);
      resolve({
        socket,
        peer,
        inputChannel,
        stateChannel,
        welcome,
        world,
        snapshot,
      });
    };
    const timeout = setTimeout(() => reject(new Error("timed out connecting test client")), 5_000);
    peer.onDataChannel.subscribe((channel) => {
      if (channel.label !== "gurgur-state-v2" || stateChannel) {
        channel.close();
        return;
      }
      stateChannel = channel;
      channel.stateChanged.subscribe((state) => {
        if (state !== "open") return;
        stateReady = true;
        done();
      });
      if (channel.readyState === "open") {
        stateReady = true;
        done();
      }
    });
    const startOffer = async (): Promise<void> => {
      if (!welcome || offerStarted) return;
      offerStarted = true;
      try {
        await peer.setLocalDescription(await peer.createOffer());
        if (!peer.localDescription?.sdp) throw new Error("test RTC offer has no SDP");
        socket.send(
          JSON.stringify({
            type: "rtc-offer",
            protocolVersion: PROTOCOL_VERSION,
            worldEpoch: welcome.worldEpoch,
            description: { type: "offer", sdp: peer.localDescription.sdp },
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          mapRevision,
          worldEpoch,
          sessionToken,
          socketGeneration,
        }),
      ),
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        if (new Uint8Array(event.data as ArrayBuffer)[0] !== SNAPSHOT_TAG) return;
        snapshot = decodeSnapshot(event.data as ArrayBuffer);
        done();
        return;
      }
      const message = JSON.parse(event.data) as
        | WelcomeMessage
        | WorldManifestMessage
        | { type: "rtc-answer"; description: { type: "answer"; sdp: string } };
      if (message.type === "welcome") welcome = message;
      if (message.type === "world") world = message;
      if (message.type === "rtc-answer")
        void peer.setRemoteDescription(message.description).catch(reject);
      void startOffer();
      done();
    });
    socket.addEventListener("error", () => reject(new Error("test client websocket failed")));
  });
}

function waitForSnapshot(
  channel: RTCDataChannel,
  predicate: (snapshot: Snapshot) => boolean,
): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.unSubscribe();
      reject(new Error("timed out waiting for snapshot"));
    }, 3_000);
    const subscription = channel.onMessage.subscribe((packet) => {
      if (typeof packet === "string" || packet[0] !== SNAPSHOT_TAG) return;
      const snapshot = decodeSnapshot(Uint8Array.from(packet).buffer);
      if (!predicate(snapshot)) return;
      clearTimeout(timeout);
      subscription.unSubscribe();
      resolve(snapshot);
    });
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
