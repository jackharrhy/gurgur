# 0008: Vanilla Bun web application and single-process deployment

Status: accepted on 2026-07-21.

Use one native `Bun.serve` process for HTML/assets, HTTP routes, gameplay
WebSockets, authoritative simulation, and `bun:sqlite`. The browser uses vanilla
TypeScript, CSS, and direct Three.js. Ship one Dockerfile and one runtime process.

Remix 3 is beta and declares a Node runtime for its CLI. Remix, React, Elysia, and
Vite add routing, rendering, adapter, or development-server layers that the game
does not need. Gurgur has one main interactive page, a small HTTP surface, and a
specialized realtime loop; Bun already supplies the required bundling, routing,
WebSocket, and SQLite primitives.

The consequence is that Gurgur owns a small amount of DOM and route code. In
return, browser assets and gameplay remain same-origin, deployment has no adapter
boundary, and the full application fits in one observable process.
