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
