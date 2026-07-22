import { describe, expect, test } from "bun:test";
import { selectVoiceGraph, type VoiceGraphPeer } from "../src/voice-graph";

const peer = (peerId: string, x: number, previousPeers: string[] = [], blockedPeerIds: string[] = []): VoiceGraphPeer => ({
  peerId, position: { x, y: 0, z: 0 }, previousPeers: new Set(previousPeers), blockedPeerIds: new Set(blockedPeerIds),
});

describe("authoritative voice graph", () => {
  test("uses 20/24 metre hysteresis without boundary churn", () => {
    expect(selectVoiceGraph([peer("a", 0), peer("b", 20.01)]).get("a")!.has("b")).toBe(false);
    expect(selectVoiceGraph([peer("a", 0, ["b"]), peer("b", 23.99, ["a"])]).get("a")!.has("b")).toBe(true);
    expect(selectVoiceGraph([peer("a", 0, ["b"]), peer("b", 24.01, ["a"])]).get("a")!.has("b")).toBe(false);
  });

  test("is symmetric, nearest-first, blocked, and capped at six", () => {
    const peers = [peer("center", 0, [], ["blocked"]), ...Array.from({ length: 8 }, (_, index) =>
      peer(index === 7 ? "blocked" : `p${index}`, index + 1))];
    const graph = selectVoiceGraph(peers);
    expect(Math.max(...[...graph.values()].map((edges) => edges.size))).toBe(6);
    expect([...graph.values()].every((edges) => edges.size <= 6)).toBe(true);
    expect(graph.get("center")!.has("blocked")).toBe(false);
    for (const [id, edges] of graph) for (const edge of edges) expect(graph.get(edge)!.has(id)).toBe(true);
  });
});
