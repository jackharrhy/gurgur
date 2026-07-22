import type { Vec3 } from "@gurgur/shared";

export type VoiceGraphPeer = {
  peerId: string;
  position: Vec3;
  blockedPeerIds: ReadonlySet<string>;
  previousPeers: ReadonlySet<string>;
};

export function selectVoiceGraph(
  peers: VoiceGraphPeer[],
  maximumDegree = 6,
): Map<string, Set<string>> {
  const graph = new Map(peers.map((peer) => [peer.peerId, new Set<string>()]));
  const candidates: Array<{ a: VoiceGraphPeer; b: VoiceGraphPeer; distance: number }> = [];
  for (let left = 0; left < peers.length; left += 1) {
    for (let right = left + 1; right < peers.length; right += 1) {
      const a = peers[left]!;
      const b = peers[right]!;
      if (a.blockedPeerIds.has(b.peerId) || b.blockedPeerIds.has(a.peerId)) continue;
      const distance = Math.hypot(
        b.position.x - a.position.x,
        b.position.y - a.position.y,
        b.position.z - a.position.z,
      );
      const retained = a.previousPeers.has(b.peerId) && b.previousPeers.has(a.peerId);
      if (distance <= (retained ? 24 : 20)) candidates.push({ a, b, distance });
    }
  }
  candidates.sort(
    (left, right) =>
      left.distance - right.distance ||
      left.a.peerId.localeCompare(right.a.peerId) ||
      left.b.peerId.localeCompare(right.b.peerId),
  );
  for (const candidate of candidates) {
    const a = graph.get(candidate.a.peerId)!;
    const b = graph.get(candidate.b.peerId)!;
    if (a.size >= maximumDegree || b.size >= maximumDegree) continue;
    a.add(candidate.b.peerId);
    b.add(candidate.a.peerId);
  }
  return graph;
}
