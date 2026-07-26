# 0018: Send ephemeral text and synthesize positional speech in each browser

Status: accepted on 2026-07-25.

Gurgur sends bounded utterance text over the reliable WebSocket control channel
and performs speech synthesis independently in every receiving browser. The
server supplies the authoritative speaker runtime ID, derives a stable ordinary
voice from its session token, applies epoch and token-bucket policy, broadcasts
to all joined clients including the sender, and retains no utterance.

This preserves the existing authority boundary without turning generated PCM
into server state. Text is small enough for reliable control, while PCM would be
larger, would require server-side native synthesis or generated-asset lifetime,
and would add media distribution latency. Client synthesis also lets each
listener attach the result immediately to its own current presentation of the
speaker. Disposable WebRTC state is rejected because losing an entire utterance
is not equivalent to dropping an obsolete position sample.

The interface is audio-first. `T` temporarily captures input; Enter submits and
Escape cancels. There is no caption or history. This deliberately accepts that
speech is inaccessible to players who cannot hear it; captions, moderation UI,
mobile text entry, voice selection, occlusion, and room-dependent acoustics are
separate product decisions.

Synchronous LinTalker synthesis runs in a dedicated worker. The worker accepts
only server-selected voice indices 0–4 and validated printable ASCII without
`[[`, returns at most 15 seconds of 22.05 kHz mono PCM using a transferable
buffer, and is isolated behind an eight-job waiting queue and world generation.
The renderer owns playback lifetime and uses Three.js positional audio with a
subtle shared speech-only convolver.

Production evidence:

- [`../../packages/engine/src/control-codec.ts`](../../packages/engine/src/control-codec.ts)
- [`../../apps/server/src/speech.ts`](../../apps/server/src/speech.ts)
- [`../../apps/web/src/speech-worker.ts`](../../apps/web/src/speech-worker.ts)
- [`../../apps/web/src/speech-synthesis.ts`](../../apps/web/src/speech-synthesis.ts)
- [`../../apps/web/src/renderer.ts`](../../apps/web/src/renderer.ts)
- [`../../apps/server/test/server.integration.test.ts`](../../apps/server/test/server.integration.test.ts)
- [`../../scripts/smoke-browser.ts`](../../scripts/smoke-browser.ts)
