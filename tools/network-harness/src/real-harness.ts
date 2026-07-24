import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import {
  INPUT_REDUNDANCY,
  LIFECYCLE_TAG,
  PHYSICS_DT,
  PROTOCOL_VERSION,
  STATE_EXTRAPOLATION_MAX_TICKS,
  decodeLifecycle,
  decodeServerControl,
  decodeSnapshot,
  encodeInputBundle,
  type BodySnapshot,
  type InputCommand,
  type Snapshot,
  type WelcomeMessage,
  type WorldManifestMessage,
} from "@gurgur/engine";
import { decodeWorldBundle, type WorldMessage } from "@gurgur/game";
import type { ServerMetrics } from "../../../apps/server/src/server";
import { PlayerPredictor } from "../../../apps/web/src/prediction";
import { createSnapshotTimeline, type SnapshotTimeline } from "../../../apps/web/src/interpolation";
import { NETWORK_PROFILES } from "./profiles";
import { UnreliableDatagramLink, type NetworkProfile } from "./unreliable-datagram-link";

type ClientMetrics = {
  clientId: number;
  profile: string;
  snapshots: number;
  inputCommands: number;
  latestAcknowledgedInputSequence: number;
  predictionErrorsMetres: number[];
  maxPredictionCorrection: {
    metres: number;
    serverTick: number;
    authority: { x: number; y: number; z: number };
    predicted: { x: number; y: number; z: number };
  } | null;
  inputLatencyMs: number[];
  snapshotAgeMs: number[];
  contactProxyOverrunSamples: number;
  contactProxySamples: number;
  inboundDroppedPackets: number;
  outboundDroppedPackets: number;
  queueHighWaterBytes: number;
  errors: string[];
};

export type HarnessReport = {
  reportVersion: 4;
  seed: number;
  buildRevision: string;
  mapRevision: string;
  worldEpoch: number;
  durationMs: number;
  clientCount: number;
  generatedAt: string;
  server: ServerMetrics;
  aggregate: {
    predictionErrorP95Metres: number;
    predictionErrorP99Metres: number;
    predictionErrorMaxMetres: number;
    inputLatencyP95Ms: number;
    snapshotAgeP95Ms: number;
    contactProxyOverrunPercent: number;
    correctnessErrors: number;
  };
  profiles: Record<string, HarnessReport["aggregate"]>;
  clients: ClientMetrics[];
  scenario: {
    name: string;
    recoveryPredictionErrorP95Metres: number;
    recoverySnapshotAgeP95Ms: number;
    recoveryPredictionSamples: number;
    recoverySnapshotSamples: number;
  };
};

type Client = {
  socket: WebSocket;
  peer: RTCPeerConnection;
  inputChannel: RTCDataChannel;
  stateChannel: RTCDataChannel | null;
  inbound: UnreliableDatagramLink<ArrayBuffer>;
  outbound: UnreliableDatagramLink<ArrayBuffer>;
  predictor: PlayerPredictor | null;
  history: SnapshotTimeline;
  welcome: WelcomeMessage | null;
  latestSnapshot: Snapshot | null;
  predictedPosition: { x: number; y: number; z: number } | null;
  sequence: number;
  nextInputAtMs: number;
  inputTimes: Map<number, number>;
  metrics: ClientMetrics;
  baseUrl: string;
  startedAt: number;
  predictionTimed: Array<{ atMs: number; value: number }>;
  snapshotAgeTimed: Array<{ atMs: number; value: number }>;
  nextRenderAtMs: number;
  inputHistory: InputCommand[];
  bodyLastReceived: Map<string, { serverTick: number; receivedAtMs: number }>;
};

export async function runRealNetworkHarness(
  options: {
    clientCount?: number;
    durationMs?: number;
    seed?: number;
    profiles?: NetworkProfile[];
    dynamicBodyCount?: number;
    scenarioName?: string;
    outage?: { clientIds: number[]; startMs: number; endMs: number };
    receiverPause?: { clientIds: number[]; untilMs: number };
    resetAtMs?: number;
  } = {},
): Promise<HarnessReport> {
  const clientCount = options.clientCount ?? 16;
  const durationMs = options.durationMs ?? 5_000;
  const seed = options.seed ?? 0x67757267;
  const profiles = options.profiles ?? [
    NETWORK_PROFILES.local,
    NETWORK_PROFILES.typical,
    NETWORK_PROFILES.adverse,
    NETWORK_PROFILES.constrained,
  ];
  if (!Number.isInteger(clientCount) || clientCount < 1 || clientCount > 64)
    throw new Error("clientCount must be between 1 and 64");
  const directory = await mkdtemp(join(tmpdir(), "gurgur-harness-"));
  const dynamicBodyCount = options.dynamicBodyCount ?? 128;
  if (!Number.isInteger(dynamicBodyCount) || dynamicBodyCount < 6 || dynamicBodyCount > 518) {
    throw new Error("dynamicBodyCount must be between 6 and 518");
  }
  const adminToken = "network-harness-admin-token";
  const server = await launchServer(directory, dynamicBodyCount - 6, adminToken);
  let startedAt = performance.now();
  const clients: Client[] = [];
  try {
    clients.push(
      ...(await Promise.all(
        Array.from({ length: clientCount }, (_, clientId) =>
          createClient(
            clientId,
            profiles[clientId % profiles.length]!,
            seed,
            server.port,
            startedAt,
          ),
        ),
      )),
    );
    startedAt = performance.now();
    for (const client of clients) {
      client.startedAt = startedAt;
      client.history = createSnapshotTimeline();
      client.inbound = new UnreliableDatagramLink(
        client.inbound.profile,
        seed + client.metrics.clientId * 2,
      );
      client.outbound = new UnreliableDatagramLink(
        client.outbound.profile,
        seed + client.metrics.clientId * 2 + 1,
      );
      client.sequence = 0;
      client.inputHistory = [];
      client.inputTimes.clear();
      client.bodyLastReceived.clear();
      client.nextRenderAtMs = 0;
      if (Number.isFinite(client.nextInputAtMs)) client.nextInputAtMs = 0;
    }
    for (const clientId of options.outage?.clientIds ?? []) {
      clients[clientId]?.inbound.addOutage(options.outage!.startMs, options.outage!.endMs);
      clients[clientId]?.outbound.addOutage(options.outage!.startMs, options.outage!.endMs);
    }
    for (const clientId of options.receiverPause?.clientIds ?? []) {
      clients[clientId]?.outbound.pauseReceiverUntil(options.receiverPause!.untilMs);
    }
    const deadline = startedAt + durationMs;
    let resetSent = false;
    while (performance.now() < deadline) {
      const now = performance.now() - startedAt;
      if (!resetSent && options.resetAtMs !== undefined && now >= options.resetAtMs) {
        resetSent = true;
        const response = await fetch(`http://127.0.0.1:${server.port}/admin/reset`, {
          method: "POST",
          headers: { authorization: `Bearer ${adminToken}` },
        });
        if (!response.ok) throw new Error(`harness reset failed with ${response.status}`);
      }
      for (const client of clients) advanceClient(client, now);
      await Bun.sleep(2);
    }
    const serverMetrics = (await (
      await fetch(`http://127.0.0.1:${server.port}/metrics`)
    ).json()) as ServerMetrics;
    const allPrediction = clients.flatMap((client) => client.metrics.predictionErrorsMetres);
    const allInputLatency = clients.flatMap((client) => client.metrics.inputLatencyMs);
    const allSnapshotAge = clients.flatMap((client) => client.metrics.snapshotAgeMs);
    const contactProxySamples = clients.reduce(
      (sum, client) => sum + client.metrics.contactProxySamples,
      0,
    );
    const contactProxyOverruns = clients.reduce(
      (sum, client) => sum + client.metrics.contactProxyOverrunSamples,
      0,
    );
    const recoveryStart = durationMs - 1_000;
    const recoveryClientIds = new Set(
      options.outage?.clientIds ??
        options.receiverPause?.clientIds ??
        clients.map((client) => client.metrics.clientId),
    );
    const recoveryClients = clients.filter((client) =>
      recoveryClientIds.has(client.metrics.clientId),
    );
    const recoveryPrediction = recoveryClients.flatMap((client) =>
      client.predictionTimed
        .filter((sample) => sample.atMs >= recoveryStart)
        .map((sample) => sample.value),
    );
    const recoveryAge = recoveryClients.flatMap((client) =>
      client.snapshotAgeTimed
        .filter((sample) => sample.atMs >= recoveryStart)
        .map((sample) => sample.value),
    );
    for (const client of clients)
      if (client.latestSnapshot?.worldEpoch !== serverMetrics.worldEpoch) {
        client.metrics.errors.push(
          `client ended on epoch ${client.latestSnapshot?.worldEpoch ?? "none"}, server is ${serverMetrics.worldEpoch}`,
        );
      }
    return {
      reportVersion: 4,
      seed,
      buildRevision: process.env.BUILD_REVISION ?? "working-tree",
      mapRevision: clients[0]?.welcome?.mapRevision ?? "unknown",
      worldEpoch: serverMetrics.worldEpoch,
      durationMs,
      clientCount,
      generatedAt: new Date().toISOString(),
      server: serverMetrics,
      aggregate: {
        predictionErrorP95Metres: percentile(allPrediction, 0.95),
        predictionErrorP99Metres: percentile(allPrediction, 0.99),
        predictionErrorMaxMetres: Math.max(0, ...allPrediction),
        inputLatencyP95Ms: percentile(allInputLatency, 0.95),
        snapshotAgeP95Ms: percentile(allSnapshotAge, 0.95),
        contactProxyOverrunPercent: contactProxySamples
          ? (contactProxyOverruns / contactProxySamples) * 100
          : 0,
        correctnessErrors: clients.reduce((sum, client) => sum + client.metrics.errors.length, 0),
      },
      profiles: Object.fromEntries(
        [...new Set(clients.map((client) => client.metrics.profile))].map((profile) => {
          const selected = clients.filter((client) => client.metrics.profile === profile);
          const prediction = selected.flatMap((client) => client.metrics.predictionErrorsMetres);
          const inputLatency = selected.flatMap((client) => client.metrics.inputLatencyMs);
          const snapshotAge = selected.flatMap((client) => client.metrics.snapshotAgeMs);
          const selectedContactProxySamples = selected.reduce(
            (sum, client) => sum + client.metrics.contactProxySamples,
            0,
          );
          const selectedContactProxyOverruns = selected.reduce(
            (sum, client) => sum + client.metrics.contactProxyOverrunSamples,
            0,
          );
          return [
            profile,
            {
              predictionErrorP95Metres: percentile(prediction, 0.95),
              predictionErrorP99Metres: percentile(prediction, 0.99),
              predictionErrorMaxMetres: Math.max(0, ...prediction),
              inputLatencyP95Ms: percentile(inputLatency, 0.95),
              snapshotAgeP95Ms: percentile(snapshotAge, 0.95),
              contactProxyOverrunPercent: selectedContactProxySamples
                ? (selectedContactProxyOverruns / selectedContactProxySamples) * 100
                : 0,
              correctnessErrors: selected.reduce(
                (sum, client) => sum + client.metrics.errors.length,
                0,
              ),
            },
          ];
        }),
      ),
      clients: clients.map((client) => ({
        ...client.metrics,
        inboundDroppedPackets: client.inbound.metrics.droppedPackets,
        outboundDroppedPackets: client.outbound.metrics.droppedPackets,
        queueHighWaterBytes: Math.max(
          client.inbound.metrics.queueHighWaterBytes,
          client.outbound.metrics.queueHighWaterBytes,
        ),
      })),
      scenario: {
        name: options.scenarioName ?? "mixed-baseline",
        recoveryPredictionErrorP95Metres: percentile(recoveryPrediction, 0.95),
        recoverySnapshotAgeP95Ms: percentile(recoveryAge, 0.95),
        recoveryPredictionSamples: recoveryPrediction.length,
        recoverySnapshotSamples: recoveryAge.length,
      },
    };
  } finally {
    for (const client of clients) {
      client.socket.close();
      await client.peer.close();
      client.predictor?.dispose();
    }
    server.process.kill("SIGTERM");
    await Promise.race([server.process.exited, Bun.sleep(3_000)]);
    await rm(directory, { recursive: true, force: true });
  }
}

async function launchServer(
  directory: string,
  extraDynamicBodies: number,
  adminToken: string,
): Promise<{
  port: number;
  process: ReturnType<typeof Bun.spawn>;
}> {
  const reservation = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = reservation.port!;
  reservation.stop(true);
  const process = Bun.spawn(["bun", "apps/server/src/index.ts"], {
    cwd: new URL("../../..", import.meta.url).pathname,
    env: {
      ...Bun.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: join(directory, "world.sqlite"),
      ADMIN_TOKEN: adminToken,
      EXTRA_DYNAMIC_BODIES: String(extraDynamicBodies),
      PLAYER_SPAWN: "0,0.9,-18",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return { port, process };
    } catch {
      /* child is still loading */
    }
    if (process.exitCode !== null)
      throw new Error(`harness server exited during startup with ${process.exitCode}`);
    await Bun.sleep(20);
  }
  process.kill("SIGKILL");
  throw new Error("harness server readiness timeout");
}

async function createClient(
  clientId: number,
  profile: NetworkProfile,
  seed: number,
  port: number,
  startedAt: number,
): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/game`);
  socket.binaryType = "arraybuffer";
  const peer = new RTCPeerConnection({
    iceAdditionalHostAddresses: ["127.0.0.1"],
  });
  const inputChannel = peer.createDataChannel("gurgur-input-v1", {
    ordered: false,
    maxRetransmits: 0,
  });
  const predictor =
    clientId < 4
      ? new PlayerPredictor((body) => {
          client.predictedPosition = body?.position ?? null;
        })
      : null;
  const client: Client = {
    socket,
    peer,
    inputChannel,
    stateChannel: null,
    inbound: new UnreliableDatagramLink(profile, seed + clientId * 2),
    outbound: new UnreliableDatagramLink(profile, seed + clientId * 2 + 1),
    predictor,
    history: createSnapshotTimeline(),
    welcome: null,
    latestSnapshot: null,
    predictedPosition: null,
    sequence: 0,
    nextInputAtMs: 0,
    inputTimes: new Map(),
    metrics: {
      clientId,
      profile: profile.name,
      snapshots: 0,
      inputCommands: 0,
      latestAcknowledgedInputSequence: -1,
      predictionErrorsMetres: [],
      maxPredictionCorrection: null,
      inputLatencyMs: [],
      snapshotAgeMs: [],
      contactProxyOverrunSamples: 0,
      contactProxySamples: 0,
      inboundDroppedPackets: 0,
      outboundDroppedPackets: 0,
      queueHighWaterBytes: 0,
      errors: [],
    },
    baseUrl: `http://127.0.0.1:${port}`,
    startedAt,
    predictionTimed: [],
    snapshotAgeTimed: [],
    nextRenderAtMs: 0,
    inputHistory: [],
    bodyLastReceived: new Map(),
  };
  const stateChannelReady = new Promise<RTCDataChannel>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`client ${clientId} state channel timeout`)),
      5_000,
    );
    peer.onDataChannel.subscribe((channel) => {
      if (channel.label !== "gurgur-state-v1" || client.stateChannel) {
        channel.close();
        return;
      }
      client.stateChannel = channel;
      channel.onMessage.subscribe((packet) => {
        if (typeof packet === "string") {
          client.metrics.errors.push("state channel delivered text");
          return;
        }
        const payload = Uint8Array.from(packet).buffer;
        client.outbound.send(performance.now() - client.startedAt, payload.byteLength, payload);
      });
      const finish = (): void => {
        clearTimeout(timeout);
        resolve(channel);
      };
      channel.stateChanged.subscribe((state) => {
        if (state === "open") finish();
      });
      if (channel.readyState === "open") finish();
    });
  });
  let answerStarted = false;
  const acceptOffer = async (description: { type: "offer"; sdp: string }): Promise<void> => {
    if (!client.welcome || answerStarted) return;
    answerStarted = true;
    await peer.setRemoteDescription(description);
    await peer.setLocalDescription(await peer.createAnswer());
    if (!peer.localDescription?.sdp) throw new Error(`client ${clientId} RTC answer has no SDP`);
    socket.send(
      JSON.stringify({
        type: "rtc-answer",
        protocolVersion: PROTOCOL_VERSION,
        worldEpoch: client.welcome.worldEpoch,
        description: { type: "answer", sdp: peer.localDescription.sdp },
      }),
    );
  };
  socket.addEventListener("message", (event) => {
    const now = performance.now() - client.startedAt;
    if (typeof event.data !== "string") {
      handleOutbound(client, event.data as ArrayBuffer, now);
      return;
    }
    const message = decodeServerControl(event.data);
    if (message.type === "rtc-offer") {
      void acceptOffer(message.description).catch((error) =>
        client.metrics.errors.push(String(error)),
      );
      return;
    }
    handleOutbound(client, event.data, now);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`client ${clientId} open timeout`)), 3_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
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
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => reject(new Error(`client ${clientId} websocket error`)),
      { once: true },
    );
  });
  await stateChannelReady;
  const worldDeadline = performance.now() + 5_000;
  while (!Number.isFinite(client.nextInputAtMs) && performance.now() < worldDeadline) {
    if (client.metrics.errors.length > 0) throw new Error(client.metrics.errors.join("; "));
    await Bun.sleep(5);
  }
  if (!Number.isFinite(client.nextInputAtMs))
    throw new Error(`client ${clientId} world load timeout`);
  return client;
}

function advanceClient(client: Client, nowMs: number, generateInput = true): void {
  for (const packet of client.outbound.advance(nowMs)) {
    handleOutbound(client, packet.payload, packet.deliveryAtMs);
  }
  if (client.welcome && generateInput) {
    while (client.nextInputAtMs <= nowMs) {
      const command = inputCommand(client, client.nextInputAtMs);
      client.metrics.inputCommands += 1;
      client.inputHistory.push(command);
      if (client.inputHistory.length > INPUT_REDUNDANCY) client.inputHistory.shift();
      const encoded = encodeInputBundle(client.inputHistory);
      client.predictor?.pushInput(command);
      client.inputTimes.set(command.sequence, client.nextInputAtMs);
      client.inbound.send(client.nextInputAtMs, encoded.byteLength, encoded);
      client.nextInputAtMs += 1_000 * PHYSICS_DT;
    }
  }
  for (const packet of client.inbound.advance(nowMs)) {
    if (client.inputChannel.readyState === "open")
      client.inputChannel.send(Buffer.from(packet.payload));
  }
  while (client.latestSnapshot && client.nextRenderAtMs <= nowMs) {
    const target =
      client.history.serverTickAt(client.nextRenderAtMs) - client.history.interpolationDelayTicks;
    if (client.nextRenderAtMs >= 500) {
      client.history.sample(target);
      const contactBodies = client.predictor?.predictedBodies ?? [];
      client.metrics.contactProxySamples += contactBodies.length;
      client.metrics.contactProxyOverrunSamples += contactBodies.filter((body) => {
        const lastReceived = client.bodyLastReceived.get(idKey(body.id));
        return (
          (lastReceived === undefined ||
            client.nextRenderAtMs - lastReceived.receivedAtMs >
              STATE_EXTRAPOLATION_MAX_TICKS * PHYSICS_DT * 1_000) &&
          moving(body)
        );
      }).length;
    } else {
      client.history.sample(target);
    }
    client.nextRenderAtMs += 1_000 / 60;
  }
}

function handleOutbound(client: Client, payload: string | ArrayBuffer, nowMs: number): void {
  if (typeof payload === "string") {
    const message = decodeServerControl(payload);
    if (message.type === "welcome") {
      client.welcome = message;
      client.predictor?.setLocalPlayer(message.playerId);
      client.nextInputAtMs = Number.POSITIVE_INFINITY;
    } else if (message.type === "world") {
      if (client.welcome && message.worldEpoch !== client.welcome.worldEpoch) {
        client.welcome = { ...client.welcome, worldEpoch: message.worldEpoch };
        client.sequence = 0;
        client.inputHistory = [];
        client.inputTimes.clear();
        client.bodyLastReceived.clear();
        client.nextInputAtMs = Number.POSITIVE_INFINITY;
      }
      void loadClientWorld(client, message);
    }
    return;
  }
  if (new DataView(payload).getUint8(0) === LIFECYCLE_TAG) {
    decodeLifecycle(payload);
    return;
  }
  const snapshot = decodeSnapshot(payload);
  for (const body of snapshot.bodies) {
    const key = idKey(body.id);
    const previousTick = client.bodyLastReceived.get(key)?.serverTick ?? -1;
    if (snapshot.serverTick > previousTick) {
      client.bodyLastReceived.set(key, {
        serverTick: snapshot.serverTick,
        receivedAtMs: nowMs,
      });
    }
  }
  client.metrics.snapshots += 1;
  client.history.push(snapshot, nowMs, client.outbound.profile.roundTripLatencyMs / 2);
  if (client.latestSnapshot && snapshot.serverTick <= client.latestSnapshot.serverTick) return;
  client.latestSnapshot = snapshot;
  client.predictor?.reconcile(snapshot);
  if (!client.welcome) return;
  const authority = snapshot.players.find((player) => sameId(player.id, client.welcome!.playerId));
  if (!authority) {
    client.metrics.errors.push(`missing local player at tick ${snapshot.serverTick}`);
    return;
  }
  client.metrics.latestAcknowledgedInputSequence = authority.lastProcessedInputSequence;
  if (client.predictor && client.metrics.snapshots > 3) {
    const correction = client.predictor.lastReconciliationError;
    client.metrics.predictionErrorsMetres.push(correction);
    client.predictionTimed.push({
      atMs: nowMs,
      value: correction,
    });
    const predicted = client.predictor.predictedPosition;
    if (
      predicted &&
      (!client.metrics.maxPredictionCorrection ||
        correction > client.metrics.maxPredictionCorrection.metres)
    )
      client.metrics.maxPredictionCorrection = {
        metres: correction,
        serverTick: snapshot.serverTick,
        authority: { ...authority.position },
        predicted,
      };
  }
  const sentAt = client.inputTimes.get(authority.lastProcessedInputSequence);
  if (sentAt !== undefined) client.metrics.inputLatencyMs.push(Math.max(0, nowMs - sentAt));
  for (const sequence of client.inputTimes.keys()) {
    if (sequence <= authority.lastProcessedInputSequence) client.inputTimes.delete(sequence);
  }
  const snapshotAge = Math.max(
    0,
    (client.history.serverTickAt(nowMs) - snapshot.serverTick) * 1_000 * PHYSICS_DT,
  );
  client.metrics.snapshotAgeMs.push(snapshotAge);
  client.snapshotAgeTimed.push({ atMs: nowMs, value: snapshotAge });
}

async function loadClientWorld(client: Client, message: WorldManifestMessage): Promise<void> {
  if (!client.predictor) {
    client.nextInputAtMs = performance.now() - client.startedAt;
    return;
  }
  try {
    const response = await fetch(`${client.baseUrl}${message.bundleUrl}`);
    const bundle = decodeWorldBundle(await response.arrayBuffer());
    if (bundle.mapRevision !== message.mapRevision)
      throw new Error("harness world revision mismatch");
    const world: WorldMessage = { ...message, bundle };
    await client.predictor.setWorld(world);
    client.nextInputAtMs = performance.now() - client.startedAt;
  } catch (error) {
    client.metrics.errors.push(String(error));
  }
}

function inputCommand(client: Client, nowMs: number): InputCommand {
  const sequence = client.sequence++;
  const direction = (Math.floor(nowMs / 2_000) + client.metrics.clientId) % 4;
  const moveX = direction === 0 ? 1 : direction === 2 ? -1 : 0;
  const moveZ = direction === 1 ? 1 : direction === 3 ? -1 : 0;
  return {
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: client.welcome!.worldEpoch,
    sequence,
    clientTick: sequence,
    moveX,
    moveZ,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    jumpCounter: 0,
    interactCounter: 0,
    interactTarget: null,
    primaryCounter: 0,
  };
}

function percentile(values: number[], amount: number): number {
  if (!values.length) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))]!;
}

function sameId(
  a: { index: number; generation: number },
  b: { index: number; generation: number },
): boolean {
  return a.index === b.index && a.generation === b.generation;
}

function idKey(id: { index: number; generation: number }): string {
  return `${id.index}:${id.generation}`;
}

function moving(body: BodySnapshot): boolean {
  return (
    Math.hypot(
      body.linearVelocity?.x ?? 0,
      body.linearVelocity?.y ?? 0,
      body.linearVelocity?.z ?? 0,
    ) > 0.0001 ||
    Math.hypot(
      body.angularVelocity?.x ?? 0,
      body.angularVelocity?.y ?? 0,
      body.angularVelocity?.z ?? 0,
    ) > 0.0001
  );
}
