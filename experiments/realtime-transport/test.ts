import assert from "node:assert/strict";

const PROTOCOL_VERSION = 1;
const WORLD_EPOCH = 7;
const clients = new Set<any>();
const acceptedInputs: Array<{ clientId: string; sequence: number }> = [];

const server = Bun.serve<{ clientId: string | null; lastSequence: number }>({
  port: 0,
  fetch(request, server) {
    if (new URL(request.url).pathname !== "/game") {
      return new Response("not found", { status: 404 });
    }

    const upgraded = server.upgrade(request, {
      data: { clientId: null, lastSequence: -1 },
    });
    return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 4 * 1024,
    idleTimeout: 30,
    open(socket) {
      clients.add(socket);
    },
    close(socket) {
      clients.delete(socket);
    },
    message(socket, raw) {
      if (typeof raw !== "string") {
        socket.close(1003, "client packets must be JSON text");
        return;
      }

      const packet = JSON.parse(raw);
      if (packet.type === "hello") {
        if (packet.protocolVersion !== PROTOCOL_VERSION) {
          socket.close(1002, "protocol version mismatch");
          return;
        }
        socket.data.clientId = packet.clientId;
        socket.send(JSON.stringify({
          type: "welcome",
          protocolVersion: PROTOCOL_VERSION,
          worldEpoch: WORLD_EPOCH,
        }));
        return;
      }

      if (packet.type === "input") {
        if (!socket.data.clientId) throw new Error("input before hello");
        if (packet.worldEpoch !== WORLD_EPOCH) return;
        if (!Number.isInteger(packet.sequence) || packet.sequence <= socket.data.lastSequence) return;
        if (!Number.isFinite(packet.moveX) || Math.abs(packet.moveX) > 1) return;
        socket.data.lastSequence = packet.sequence;
        acceptedInputs.push({ clientId: socket.data.clientId, sequence: packet.sequence });
        return;
      }

      socket.close(1003, "unknown packet");
    },
  },
});

function openClient(clientId: string, protocolVersion = PROTOCOL_VERSION) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/game`);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("error", () => reject(new Error(`socket ${clientId} failed`)), { once: true });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", clientId, protocolVersion }));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const packet = JSON.parse(event.data);
      if (packet.type === "welcome") resolve(socket);
    });
  });
}

function nextBinary(socket: WebSocket) {
  return new Promise<ArrayBuffer>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) resolve(event.data);
    }, { once: true });
  });
}

function snapshot(tick: number) {
  const bytes = new ArrayBuffer(13);
  const view = new DataView(bytes);
  view.setUint8(0, 1);
  view.setUint32(1, WORLD_EPOCH, true);
  view.setUint32(5, tick, true);
  view.setFloat32(9, tick * 0.25, true);
  return bytes;
}

try {
  const [alice, bob] = await Promise.all([openClient("alice"), openClient("bob")]);

  alice.send(JSON.stringify({ type: "input", worldEpoch: WORLD_EPOCH, sequence: 1, moveX: 1 }));
  alice.send(JSON.stringify({ type: "input", worldEpoch: WORLD_EPOCH, sequence: 1, moveX: 1 }));
  alice.send(JSON.stringify({ type: "input", worldEpoch: WORLD_EPOCH - 1, sequence: 2, moveX: 1 }));
  bob.send(JSON.stringify({ type: "input", worldEpoch: WORLD_EPOCH, sequence: 1, moveX: -1 }));

  await Bun.sleep(10);
  assert.deepEqual(acceptedInputs, [
    { clientId: "alice", sequence: 1 },
    { clientId: "bob", sequence: 1 },
  ]);

  const aliceSnapshot = nextBinary(alice);
  const bobSnapshot = nextBinary(bob);
  const payload = snapshot(42);
  const sendResults = [...clients].map((socket) => socket.send(payload));
  assert.ok(sendResults.every((result) => result > 0), `unexpected send results ${sendResults}`);

  for (const bytes of await Promise.all([aliceSnapshot, bobSnapshot])) {
    const view = new DataView(bytes);
    assert.equal(view.getUint8(0), 1);
    assert.equal(view.getUint32(1, true), WORLD_EPOCH);
    assert.equal(view.getUint32(5, true), 42);
    assert.equal(view.getFloat32(9, true), 10.5);
  }

  const rejected = new Promise<CloseEvent>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/game`);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", clientId: "old", protocolVersion: 0 }));
    });
    socket.addEventListener("close", resolve, { once: true });
  });
  assert.equal((await rejected).code, 1002);

  alice.close();
  bob.close();
  console.log("Bun native WebSocket authoritative transport: passed");
} finally {
  server.stop(true);
}
