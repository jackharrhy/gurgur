import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import { guardIceUdpSockets, resolveMdnsCandidates } from "../src/rtc";

describe("Firefox mDNS ICE candidates", () => {
  test("resolves obfuscated host candidates before werift starts connectivity checks", async () => {
    const description = {
      type: "answer" as const,
      sdp: [
        "v=0",
        "a=candidate:0 1 UDP 2122252543 browser-host.local 54788 typ host",
        "a=candidate:1 1 TCP 2105524479 browser-host.local 9 typ host tcptype active",
        "a=end-of-candidates",
        "",
      ].join("\r\n"),
    };
    const resolved = await resolveMdnsCandidates(description, async (hostname) => {
      expect(hostname).toBe("browser-host.local");
      return "192.0.2.8";
    });
    expect(resolved.sdp).toContain("a=candidate:0 1 UDP 2122252543 192.0.2.8 54788 typ host");
    expect(resolved.sdp).toContain(
      "a=candidate:1 1 TCP 2105524479 192.0.2.8 9 typ host tcptype active",
    );
  });
});

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
