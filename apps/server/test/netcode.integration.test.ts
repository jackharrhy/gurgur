import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import {
  BOOTSTRAP_STATE_TAG,
  LIFECYCLE_TAG,
  NETWORK_FLAG_HELD,
  OWNERSHIP_CHANGED_TAG,
  PROTOCOL_VERSION,
  STATE_CLUSTER_TAG,
  StateReceiver,
  binaryPacketTag,
  decodeBootstrapState,
  decodeLifecycle,
  decodeOwnershipChanged,
  decodeServerControl,
  decodeStateCluster,
  encodeOwnerCommit,
  encodeOwnedState,
  encodeOwnershipDrop,
  encodeStateAck,
  type BootstrapStatePacket,
  type NetworkBodyState,
  type NetworkObjectState,
  type OwnershipChangedPacket,
  type RuntimeId,
  type WelcomeMessage,
  type WorldManifestMessage,
} from "@gurgur/engine";
import { compileWorld } from "@gurgur/game";
import { createGurgurServer, type GurgurServer } from "../src/server";
import { guardIceUdpSockets } from "../src/rtc";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

describe("protocol-v5 real server transport", () => {
  test("relays browser-owned state over unordered WebRTC from a reliable bootstrap", async () => {
    const { server } = await launch();
    const first = await connect(server.port);
    const observer = await connect(server.port);
    cleanup.push(
      () => close(first),
      () => close(observer),
    );

    expect(first.welcome.stateHz).toBe(30);
    expect(
      first.world.runtimeEntities.find((entity) => same(entity.id, first.welcome.playerId)),
    ).toMatchObject({
      kind: "player",
      ownerPlayerId: first.welcome.playerId,
      transferPolicy: "fixed",
    });
    expect((await fetch(`http://127.0.0.1:${server.port}/physics-worker.js`)).ok).toBe(true);

    const initial = first.receiver.state(first.welcome.playerId);
    if (!initial || initial.kind !== "player") throw new Error("missing owned player bootstrap");
    const published: NetworkObjectState = {
      ...initial,
      stateSequence: (initial.stateSequence + 1) & 0xffff,
      position: { ...initial.position, x: initial.position.x + 1.5 },
    };
    const relayedPromise = waitForState(
      observer,
      (state) =>
        state.kind === "player" &&
        same(state.id, first.welcome.playerId) &&
        state.stateSequence === published.stateSequence,
    );
    first.owner.send(
      Buffer.from(encodeOwnedState({ worldEpoch: first.world.worldEpoch, states: [published] })),
    );
    const relayed = await relayedPromise;
    expect(relayed.position.x).toBeCloseTo(published.position.x, 5);
    expect(observer.acks).toBeGreaterThan(0);
    expect(server.metrics().stateTransportClients).toBe(2);

    const committed = {
      ...published,
      stateSequence: (published.stateSequence + 1) & 0xffff,
      position: { ...published.position, y: published.position.y + 0.25 },
    };
    const commitPromise = waitForOwnership(
      observer,
      (message) =>
        same(message.id, first.welcome.playerId) &&
        message.state.stateSequence === committed.stateSequence,
    );
    first.socket.send(
      encodeOwnerCommit({
        worldEpoch: first.world.worldEpoch,
        states: [committed],
      }),
    );
    const commit = await commitPromise;
    expect(commit.ownerPlayerId).toEqual(first.welcome.playerId);
    expect(commit.state.position.y).toBeCloseTo(committed.position.y, 5);
  });

  test("serializes first-grabber-wins, owner publication, and velocity-preserving drop", async () => {
    const path = "content/maps/fixtures/network-push-corridor.map";
    const bundle = compileWorld(await Bun.file(path).text(), path);
    const prop = bundle.entities.find(
      (entity) => entity.kind === "physics-prop" && entity.authoredId === "corridor.light",
    );
    if (!prop) throw new Error("pickup fixture is unavailable");
    const brush = bundle.brushes[prop.body!.brushIndices[0]!]!;
    const { server, adminToken } = await launch({
      worldBundle: bundle,
      playerSpawn: { ...brush.center },
    });
    const first = await connect(server.port);
    const second = await connect(server.port);
    cleanup.push(
      () => close(first),
      () => close(second),
    );
    const target = first.world.runtimeEntities.find(
      (entity) =>
        entity.kind === "world-entity" && entity.entityIndex === bundle.entities.indexOf(prop),
    )!;
    const initial = first.receiver.state(target.id);
    if (!initial || initial.kind !== "body") throw new Error("missing prop bootstrap");

    const request = {
      type: "ownership-request" as const,
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: first.world.worldEpoch,
      requestId: 10,
      target: target.id,
      authorityVersion: initial.authorityVersion,
      holdDistance: 2,
      relativeRotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    const grantPromise = waitForOwnership(first, (message) => same(message.id, target.id));
    const denialPromise = waitForText(second, "ownership-denied");
    first.socket.send(JSON.stringify(request));
    second.socket.send(JSON.stringify({ ...request, requestId: 11 }));
    const grant = await grantPromise;
    expect(grant.ownerPlayerId).toEqual(first.welcome.playerId);
    expect(grant.state.flags & NETWORK_FLAG_HELD).toBe(NETWORK_FLAG_HELD);
    const denial = await denialPromise;
    expect(denial).toMatchObject({ requestId: 11, reason: "stale" });

    const finalState: NetworkBodyState = {
      ...(grant.state as NetworkBodyState),
      stateSequence: 4,
      position: { ...grant.state.position, y: grant.state.position.y + 0.5 },
      linearVelocity: { x: 2.5, y: 0, z: 0 },
    };
    const relayedPromise = waitForState(
      second,
      (state) =>
        state.kind === "body" &&
        same(state.id, target.id) &&
        state.stateSequence === finalState.stateSequence,
    );
    first.owner.send(
      Buffer.from(
        encodeOwnedState({
          worldEpoch: first.world.worldEpoch,
          states: [finalState],
        }),
      ),
    );
    await relayedPromise;
    const droppedPromise = waitForOwnership(
      second,
      (message) =>
        same(message.id, target.id) &&
        message.ownerPlayerId === null &&
        message.authorityVersion > grant.authorityVersion,
    );
    first.socket.send(
      encodeOwnershipDrop({
        worldEpoch: first.world.worldEpoch,
        id: target.id,
        authorityVersion: grant.authorityVersion,
        state: finalState,
      }),
    );
    const dropped = await droppedPromise;
    expect(dropped.state.linearVelocity.x).toBeCloseTo(2.5, 5);

    const resetWorld = waitForWorld(first, grant.worldEpoch + 1);
    const reset = await fetch(`http://127.0.0.1:${server.port}/admin/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(reset.ok).toBe(true);
    await resetWorld;
    await waitForCondition(() =>
      first.receiver
        .states()
        .some(
          (state) =>
            state.kind === "player" &&
            same(state.id, first.welcome.playerId) &&
            state.authorityVersion > 1,
        ),
    );
    expect(first.receiver.states().every((state) => state.authorityVersion >= 1)).toBe(true);
  });
});

type TestClient = {
  socket: WebSocket;
  peer: RTCPeerConnection;
  owner: RTCDataChannel;
  state: RTCDataChannel;
  welcome: WelcomeMessage;
  world: WorldManifestMessage;
  receiver: StateReceiver;
  acks: number;
  states: Array<(state: NetworkObjectState) => void>;
  ownership: Array<(message: OwnershipChangedPacket) => void>;
  texts: Array<(message: Record<string, unknown>) => void>;
  worlds: Array<(message: WorldManifestMessage) => void>;
};

async function launch(
  options: {
    worldBundle?: NonNullable<Parameters<typeof createGurgurServer>[0]>["worldBundle"];
    playerSpawn?: NonNullable<Parameters<typeof createGurgurServer>[0]>["playerSpawn"];
  } = {},
): Promise<{ server: GurgurServer; directory: string; adminToken: string }> {
  const directory = await mkdtemp(join(tmpdir(), "gurgur-v5-"));
  const adminToken = "protocol-v5-test";
  const server = await createGurgurServer({
    port: 0,
    hostname: "127.0.0.1",
    databasePath: join(directory, "world.sqlite"),
    adminToken,
    ...options,
  });
  cleanup.push(() => {
    server.stop();
    return rm(directory, { recursive: true, force: true });
  });
  return { server, directory, adminToken };
}

function connect(port: number): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/game`);
    socket.binaryType = "arraybuffer";
    const peer = new RTCPeerConnection({ iceAdditionalHostAddresses: ["127.0.0.1"] });
    const owner = peer.createDataChannel("gurgur-owner-v5", {
      ordered: false,
      maxRetransmits: 0,
    });
    const receiver = new StateReceiver();
    let state: RTCDataChannel | null = null;
    let welcome: WelcomeMessage | null = null;
    let world: WorldManifestMessage | null = null;
    let bootstrap: BootstrapStatePacket | null = null;
    let ownerOpen = false;
    let stateOpen = false;
    let answerStarted = false;
    const stateListeners: TestClient["states"] = [];
    const ownershipListeners: TestClient["ownership"] = [];
    const textListeners: TestClient["texts"] = [];
    const worldListeners: TestClient["worlds"] = [];
    let acks = 0;
    const client = (): TestClient => ({
      socket,
      peer,
      owner,
      state: state!,
      welcome: welcome!,
      world: world!,
      receiver,
      get acks() {
        return acks;
      },
      states: stateListeners,
      ownership: ownershipListeners,
      texts: textListeners,
      worlds: worldListeners,
    });
    const timeout = setTimeout(() => reject(new Error("timed out connecting v5 client")), 7_500);
    const done = (): void => {
      if (!state || !welcome || !world || !bootstrap || !ownerOpen || !stateOpen) return;
      clearTimeout(timeout);
      resolve(client());
    };
    owner.stateChanged.subscribe((value) => {
      ownerOpen = value === "open";
      done();
    });
    peer.onDataChannel.subscribe((channel) => {
      if (channel.label !== "gurgur-state-v5" || state) {
        channel.close();
        return;
      }
      state = channel;
      channel.stateChanged.subscribe((value) => {
        stateOpen = value === "open";
        done();
      });
      channel.onMessage.subscribe((packet) => {
        if (typeof packet === "string") return;
        const cluster = decodeStateCluster(packet);
        const received = receiver.applyCluster(cluster);
        for (const accepted of received.accepted)
          for (const listener of stateListeners.splice(0)) listener(accepted);
        if (received.ack.entries.length > 0) {
          owner.send(Buffer.from(encodeStateAck(received.ack)));
          acks += 1;
        }
      });
    });
    const acceptOffer = async (description: { type: "offer"; sdp: string }): Promise<void> => {
      if (!welcome || answerStarted) return;
      answerStarted = true;
      try {
        await peer.setRemoteDescription(description);
        await peer.setLocalDescription(await peer.createAnswer());
        guardIceUdpSockets(peer);
        if (!peer.localDescription?.sdp) throw new Error("RTC answer is missing SDP");
        socket.send(
          JSON.stringify({
            type: "rtc-answer",
            protocolVersion: PROTOCOL_VERSION,
            worldEpoch: welcome.worldEpoch,
            description: { type: "answer", sdp: peer.localDescription.sdp },
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          mapRevision: null,
          worldEpoch: null,
          sessionToken: null,
          socketGeneration: 0,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = decodeServerControl(event.data);
        if (message.type === "welcome") welcome = message;
        else if (message.type === "world") {
          world = message;
          for (const listener of worldListeners.splice(0)) listener(message);
        } else if (message.type === "rtc-offer") void acceptOffer(message.description);
        for (const listener of textListeners.splice(0))
          listener(message as unknown as Record<string, unknown>);
        done();
        return;
      }
      const data = event.data as ArrayBuffer;
      const tag = binaryPacketTag(data);
      if (tag === BOOTSTRAP_STATE_TAG) {
        bootstrap = decodeBootstrapState(data);
        receiver.reset(bootstrap.states);
      } else if (tag === OWNERSHIP_CHANGED_TAG) {
        const message = decodeOwnershipChanged(data);
        receiver.replaceReliable(message.state);
        for (const listener of ownershipListeners.splice(0)) listener(message);
      } else if (tag === LIFECYCLE_TAG) {
        const lifecycle = decodeLifecycle(data);
        for (const removed of lifecycle.removed) receiver.remove(removed);
      } else if (tag === STATE_CLUSTER_TAG && state) {
        const cluster = decodeStateCluster(data);
        receiver.applyCluster(cluster);
      }
      done();
    });
    socket.addEventListener("error", () => reject(new Error("v5 websocket failed")));
  });
}

function waitForState(
  client: TestClient,
  predicate: (state: NetworkObjectState) => boolean,
): Promise<NetworkObjectState> {
  return wait(client.states, predicate, "state");
}

function waitForOwnership(
  client: TestClient,
  predicate: (message: OwnershipChangedPacket) => boolean,
): Promise<OwnershipChangedPacket> {
  return wait(client.ownership, predicate, "ownership");
}

function waitForText(client: TestClient, type: string): Promise<Record<string, unknown>> {
  return wait(client.texts, (message) => message.type === type, type);
}

function waitForWorld(client: TestClient, epoch: number): Promise<WorldManifestMessage> {
  if (client.world.worldEpoch === epoch) return Promise.resolve(client.world);
  return wait(client.worlds, (message) => message.worldEpoch === epoch, "world");
}

function wait<T>(
  listeners: Array<(value: T) => void>,
  predicate: (value: T) => boolean,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
    const listener = (value: T): void => {
      if (!predicate(value)) {
        listeners.push(listener);
        return;
      }
      clearTimeout(timeout);
      resolve(value);
    };
    listeners.push(listener);
  });
}

async function close(client: TestClient): Promise<void> {
  await client.peer.close();
  client.socket.close();
}

function same(a: RuntimeId, b: RuntimeId): boolean {
  return a.index === b.index && a.generation === b.generation;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}
