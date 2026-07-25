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

export function prepareMdnsIceDescription<T extends "offer" | "answer">(description: {
  type: T;
  sdp: string;
}): { type: T; sdp: string } {
  const lines = description.sdp.split("\r\n");
  const hasMdnsCandidate = lines.some((line) => {
    if (!line.startsWith("a=candidate:")) return false;
    const fields = line.split(/\s+/);
    return fields[4]?.toLowerCase().endsWith(".local");
  });
  if (!hasMdnsCandidate) return description;
  return {
    type: description.type,
    // Werift resolves mDNS candidates itself. Do not tell its ICE agent that
    // gathering is over while that asynchronous resolution—or an inbound
    // connectivity check that creates a peer-reflexive candidate—is pending.
    sdp: lines.filter((line) => line !== "a=end-of-candidates").join("\r\n"),
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
