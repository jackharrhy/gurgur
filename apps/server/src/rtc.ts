import { lookup } from "node:dns/promises";
import type { RTCPeerConnection } from "werift";

type IceSocket = {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
};

type IceProtocol = {
  transport?: {
    socket?: IceSocket;
  };
};

const guardedSockets = new WeakSet<object>();
const unreachableCodes = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

export async function resolveMdnsCandidates<T extends "offer" | "answer">(
  description: { type: T; sdp: string },
  resolve: (hostname: string) => Promise<string> = async (hostname) =>
    (await lookup(hostname, { family: 4 })).address,
): Promise<{ type: T; sdp: string }> {
  const lines = description.sdp.split("\r\n");
  const hostnames = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith("a=candidate:")) continue;
    const hostname = line.split(/\s+/)[4];
    if (hostname?.endsWith(".local")) hostnames.add(hostname);
  }
  if (hostnames.size === 0) return description;
  const addresses = new Map(
    await Promise.all(
      [...hostnames].map(async (hostname) => [hostname, await resolve(hostname)] as const),
    ),
  );
  return {
    type: description.type,
    sdp: lines
      .map((line) => {
        if (!line.startsWith("a=candidate:")) return line;
        const fields = line.split(/\s+/);
        const address = addresses.get(fields[4] ?? "");
        if (address) fields[4] = address;
        return fields.join(" ");
      })
      .join("\r\n"),
  };
}

export function guardIceUdpSockets(
  peer: RTCPeerConnection,
  reportUnexpectedError: (error: NodeJS.ErrnoException) => void = console.error,
): void {
  for (const iceTransport of peer.iceTransports) {
    const connection = iceTransport.connection as unknown as {
      protocols?: IceProtocol[];
    };
    for (const protocol of connection.protocols ?? []) {
      const socket = protocol.transport?.socket;
      if (!socket || guardedSockets.has(socket)) continue;
      guardedSockets.add(socket);
      socket.on("error", (error) => {
        if (!unreachableCodes.has(error.code ?? "")) reportUnexpectedError(error);
      });
    }
  }
}
