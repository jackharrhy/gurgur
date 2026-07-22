# Physics runtime decision

Question: can the exact `box3d.js@0.0.2` single-threaded artifact run behind the
same API in Bun and a browser worker?

Run `bun install --frozen-lockfile && bun run check`.

Acceptance criteria:

- separate-Wasm and inline-Wasm builds create and destroy repeated worlds;
- fixed 60 Hz stepping produces movement and contacts;
- both variants produce the same rounded resting states;
- the same scenario passes in Bun and a Chrome module worker.

Decision after passing: use the separate-Wasm single-threaded build in both
runtimes. Keep the inline build only as a diagnostic fallback. Gurgur owns a
narrow lifecycle-safe adapter over the generated API.
