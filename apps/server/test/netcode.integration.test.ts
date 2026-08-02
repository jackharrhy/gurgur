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
  encodeManipulationState,
  encodeOwnerCommit,
  encodeOwnedState,
  encodeStateAck,
  type BootstrapStatePacket,
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

describe("protocol-v6 real server transport", () => {
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
    const delayed = {
      ...published,
      stateSequence: (published.stateSequence + 1) & 0xffff,
      sourceTick: (published.sourceTick + 2) >>> 0,
      position: { ...published.position, x: published.position.x + 0.25 },
    };
    const delayedPromise = waitForState(
      observer,
      (state) =>
        state.kind === "player" &&
        same(state.id, first.welcome.playerId) &&
        state.stateSequence === delayed.stateSequence,
    );
    await Bun.sleep(100);
    first.owner.send(
      Buffer.from(encodeOwnedState({ worldEpoch: first.world.worldEpoch, states: [delayed] })),
    );
    const mappedDelayed = await delayedPromise;
    expect((mappedDelayed.sourceTick - relayed.sourceTick) >>> 0).toBe(2);
    expect(observer.acks).toBeGreaterThan(0);
    expect(server.metrics().stateTransportClients).toBe(2);

    const committed = {
      ...delayed,
      stateSequence: (delayed.stateSequence + 1) & 0xffff,
      sourceTick: (delayed.sourceTick + 1) >>> 0,
      position: { ...delayed.position, y: delayed.position.y + 0.25 },
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

  test("keeps a loose grab host-owned across exclusive claim, targets, and release", async () => {
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

    expect(target).toMatchObject({ ownerPlayerId: null, transferPolicy: "fixed" });
    first.owner.send(
      Buffer.from(
        encodeOwnedState({
          worldEpoch: first.world.worldEpoch,
          states: [
            {
              ...initial,
              stateSequence: (initial.stateSequence + 1) & 0xffff,
              position: { x: 9_000, y: 9_000, z: 9_000 },
            },
          ],
        }),
      ),
    );
    await Bun.sleep(100);
    expect(first.receiver.state(target.id)?.position.x).not.toBeCloseTo(9_000, 1);

    const request = {
      type: "manipulation-request" as const,
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: first.world.worldEpoch,
      requestId: 10,
      target: target.id,
      authorityVersion: initial.authorityVersion,
      localAnchor: { x: 0, y: 0, z: 0 },
      holdDistance: 2,
    };
    const grantPromise = waitForText(first, "manipulation-changed");
    const denialPromise = waitForText(second, "manipulation-denied");
    first.socket.send(JSON.stringify(request));
    second.socket.send(JSON.stringify({ ...request, requestId: 11 }));
    const grant = await grantPromise;
    expect(grant.manipulatorPlayerId).toEqual(first.welcome.playerId);
    expect(grant.authorityVersion).toBe(initial.authorityVersion);
    const denial = await denialPromise;
    expect(denial).toMatchObject({ requestId: 11, reason: "busy" });

    const movedPromise = waitForState(
      second,
      (state) =>
        state.kind === "body" &&
        same(state.id, target.id) &&
        state.position.y > initial.position.y + 0.05,
    );
    const hotSourceTicks: number[] = [];
    let collectHotStates = true;
    const collectHotState = (state: NetworkObjectState): void => {
      if (state.kind === "body" && same(state.id, target.id)) hotSourceTicks.push(state.sourceTick);
      if (collectHotStates) second.states.push(collectHotState);
    };
    second.states.push(collectHotState);
    const claimVersion = Number(grant.claimVersion);
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      first.owner.send(
        Buffer.from(
          encodeManipulationState({
            worldEpoch: first.world.worldEpoch,
            target: target.id,
            authorityVersion: initial.authorityVersion,
            claimVersion,
            stateSequence: sequence,
            targetPosition: {
              x: initial.position.x,
              y: initial.position.y + 0.8,
              z: initial.position.z,
            },
            targetRotation: initial.rotation,
          }),
        ),
      );
      await Bun.sleep(16);
    }
    const moved = await movedPromise;
    await Bun.sleep(100);
    collectHotStates = false;
    const pendingCollector = second.states.indexOf(collectHotState);
    if (pendingCollector >= 0) second.states.splice(pendingCollector, 1);
    expect(hotSourceTicks.length).toBeGreaterThanOrEqual(5);
    expect(
      hotSourceTicks
        .slice(1)
        .some((sourceTick, index) => sourceTick - (hotSourceTicks[index] as number) === 1),
    ).toBeTrue();
    expect(moved.flags & NETWORK_FLAG_HELD).toBe(NETWORK_FLAG_HELD);
    expect(moved.authorityVersion).toBe(initial.authorityVersion);
    const droppedPromise = waitForText(second, "manipulation-changed");
    first.socket.send(
      JSON.stringify({
        type: "manipulation-drop",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: first.world.worldEpoch,
        target: target.id,
        authorityVersion: initial.authorityVersion,
        claimVersion,
      }),
    );
    const dropped = await droppedPromise;
    expect(dropped.manipulatorPlayerId).toBeNull();
    expect(target.ownerPlayerId).toBeNull();

    const resetWorld = waitForWorld(first, first.world.worldEpoch + 1);
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

  test("keeps a manipulated contraption host-owned across reliable claim and disposable targets", async () => {
    const path = "content/maps/fixtures/physics-contraptions.map";
    const bundle = compileWorld(await Bun.file(path).text(), path);
    const prop = bundle.entities.find(
      (entity) => entity.kind === "physics-prop" && entity.authoredId === "fixture.lever.body",
    );
    if (!prop || prop.kind !== "physics-prop") throw new Error("lever fixture is unavailable");
    const brush = bundle.brushes[prop.body.brushIndices[0]!]!;
    const { server } = await launch({
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
    if (!initial || initial.kind !== "body") throw new Error("missing lever bootstrap");
    const request = {
      type: "manipulation-request" as const,
      protocolVersion: PROTOCOL_VERSION,
      worldEpoch: first.world.worldEpoch,
      requestId: 40,
      target: target.id,
      authorityVersion: initial.authorityVersion,
      localAnchor: { x: 1.5, y: 0, z: 0 },
      holdDistance: 1.5,
    };
    const grantPromise = waitForText(first, "manipulation-changed");
    const denialPromise = waitForText(second, "manipulation-denied");
    first.socket.send(JSON.stringify(request));
    second.socket.send(JSON.stringify({ ...request, requestId: 41 }));
    const grant = await grantPromise;
    expect(grant.manipulatorPlayerId).toEqual(first.welcome.playerId);
    expect(grant.authorityVersion).toBe(initial.authorityVersion);
    expect((await denialPromise).reason).toBe("busy");
    const claimVersion = Number(grant.claimVersion);
    const movedPromise = waitForState(
      second,
      (state) =>
        state.kind === "body" &&
        same(state.id, target.id) &&
        (Math.hypot(
          state.position.x - initial.position.x,
          state.position.y - initial.position.y,
          state.position.z - initial.position.z,
        ) > 0.01 ||
          Math.hypot(
            state.rotation.x - initial.rotation.x,
            state.rotation.y - initial.rotation.y,
            state.rotation.z - initial.rotation.z,
            state.rotation.w - initial.rotation.w,
          ) > 0.01),
    );
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      first.owner.send(
        Buffer.from(
          encodeManipulationState({
            worldEpoch: first.world.worldEpoch,
            target: target.id,
            authorityVersion: initial.authorityVersion,
            claimVersion,
            stateSequence: sequence,
            targetPosition: {
              x: initial.position.x + 1.5,
              y: initial.position.y + 0.8,
              z: initial.position.z,
            },
            targetRotation: initial.rotation,
          }),
        ),
      );
      await Bun.sleep(16);
    }
    const moved = await movedPromise;
    expect(moved.authorityVersion).toBe(initial.authorityVersion);
    expect(target.ownerPlayerId).toBeNull();
    const droppedPromise = waitForText(second, "manipulation-changed");
    first.socket.send(
      JSON.stringify({
        type: "manipulation-drop",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: first.world.worldEpoch,
        target: target.id,
        authorityVersion: initial.authorityVersion,
        claimVersion,
      }),
    );
    expect((await droppedPromise).manipulatorPlayerId).toBeNull();
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
  const directory = await mkdtemp(join(tmpdir(), "gurgur-v6-"));
  const adminToken = "protocol-v6-test";
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
    const owner = peer.createDataChannel("gurgur-owner-v6", {
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
    const timeout = setTimeout(() => reject(new Error("timed out connecting v6 client")), 7_500);
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
      if (channel.label !== "gurgur-state-v6" || state) {
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
    socket.addEventListener("error", () => reject(new Error("v6 websocket failed")));
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
