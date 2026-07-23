import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import { guardIceUdpSockets } from "../src/rtc";

describe("werift ICE UDP socket guard", () => {
  test("absorbs unreachable endpoints, reports unexpected errors, and installs once", () => {
    const listeners: Array<(error: NodeJS.ErrnoException) => void> = [];
    const socket = {
      on(_event: "error", listener: (error: NodeJS.ErrnoException) => void) {
        listeners.push(listener);
      },
    };
    const peer = {
      iceTransports: [{ connection: { protocols: [{ transport: { socket } }] } }],
    } as unknown as RTCPeerConnection;
    const unexpected: NodeJS.ErrnoException[] = [];

    guardIceUdpSockets(peer, (error) => unexpected.push(error));
    guardIceUdpSockets(peer, (error) => unexpected.push(error));
    expect(listeners).toHaveLength(1);
    const listener = listeners[0]!;

    listener(Object.assign(new Error("remote closed"), { code: "ECONNREFUSED" }));
    expect(unexpected).toHaveLength(0);

    const programmingError = Object.assign(new Error("bad descriptor"), { code: "EBADF" });
    listener(programmingError);
    expect(unexpected).toEqual([programmingError]);
  });
});
