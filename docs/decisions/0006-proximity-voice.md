# 0006: Proximity voice

Status: accepted on 2026-07-21.

Use a server-signaled WebRTC Opus peer mesh whose authoritative symmetric
proximity graph has maximum degree six and prioritizes the nearest permitted
pairs. Gameplay WebSocket carries authenticated signaling and membership.
STUN/TURN provide connectivity; relay-only mode provides network-address privacy.

The hard cap makes mesh upload, CPU, and connection churn bounded while preserving
direct media delivery. An SFU would add a separately operated service before the
product demonstrates that it needs larger audible groups. geckos.io carries data
channels, not media tracks, and is unrelated to this choice.

Blocking is enforced by the server and tears down media. Local mute changes gain
only. Voice permission, failure, or absence never affects gameplay.
