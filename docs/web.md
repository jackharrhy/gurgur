# Browser application and deployment

## Web stack

The browser application is one Bun-bundled HTML entrypoint written in vanilla
TypeScript, CSS, and direct Three.js. It has no application framework, server-side
rendering, virtual DOM, frontend development server, or client data framework.

The sole Bun server imports the HTML entrypoint and serves it through
`Bun.serve`. In development, Bun provides TypeScript/asset bundling and hot
reload. The production build emits hashed browser assets served by the same Bun
process that owns gameplay.

Excluded dependencies are Remix, React, React Three Fiber, Elysia, Express, Vite,
Next.js, and a separate static-file server.

## Browser modules

Keep the browser application as modules inside `apps/web` until reuse establishes
a package boundary:

```text
apps/web/
  index.html
  main.ts
  style.css
  session.ts            WebSocket lifecycle and protocol dispatch
  prediction-worker.ts  Box3D worker entrypoint
  prediction-client.ts  worker ownership and message bridge
  prediction.ts         replay and reconciliation implementation
  presentation.ts       fixed-pose/display-frame smoothing
  renderer.ts           Three.js scene, camera, objects, render loop
  interpolation.ts      remote snapshot histories and visual sampling
  input.ts              keyboard, pointer lock, gamepad, touch intent
  audio.ts              Web Audio and optional WebRTC voice
```

`main.ts` composes the modules but owns no simulation state. The prediction worker
owns predicted physics. `session.ts` owns network state. `renderer.ts` owns
Three.js objects and `requestAnimationFrame`. UI code updates ordinary DOM nodes
at human-facing rates and never receives per-frame transforms as application
state.

## Three.js lifecycle

There is one renderer, scene, camera rig, and animation loop for the lifetime of
the play page. Map geometry is created from the compiled world bundle. Runtime
objects are keyed by generation-bearing network identity. Each frame samples
interpolated visual transforms from client state and applies them directly to
Three.js objects.

Resizing updates renderer pixel ratio and camera projection. Losing visibility
pauses presentation and input transmission without advancing local physics by
elapsed wall time. Leaving the page closes the gameplay socket, prediction worker,
audio graph, peer connections, geometries, materials, and renderer resources.

## Visual language

Three.js `WebGPURenderer` remains the scene and presentation backend, using its
WebGL 2 fallback when WebGPU is unavailable. `RenderPipeline` and TSL own the
shader graph; handwritten GLSL and the legacy post-processing stack are excluded.
The world renders into a nearest-neighbour target capped at 480 x 270, then a TSL
resolve applies coarse channel quantization and a restrained vignette. Surface
textures retain nearest-neighbour magnification but use mip levels under
minification to prevent screen-scale moire patterns.
The CSS canvas fills the viewport independently, preserving low-resolution pixels
without tying gameplay layout to a fixed window size.

World materials use compact authored palettes, pixel-magnified 32 x 32 procedural
textures and shadow-map-free Gouraud lighting explicitly evaluated in TSL's vertex
stage. Clip-space vertex snapping and partially affine UV interpolation provide
controlled software-renderer instability without sacrificing texture mip levels.
Large concrete and stone surfaces use deterministic irregular aggregate instead
of periodic line grids, preventing grazing-angle moire without smoothing away the
pixel texture language.
Water, caution, danger, and platform materials animate UVs in TSL; water combines
two independently moving translucent samples and a slow palette pulse. Decorative
`env_sprite` point entities and player sprites are camera-facing pixel billboards.
These choices are presentation rules rather than simulation constraints: physics,
interaction rays, map geometry, and network transforms remain full precision.

## Routes

The server exposes a deliberately small surface:

| Route                                     | Purpose                           |
| ----------------------------------------- | --------------------------------- |
| `/` and SPA fallback                      | browser application               |
| `/game`                                   | gameplay WebSocket upgrade        |
| `/healthz`                                | process and event-loop health     |
| `/readyz`                                 | map, Box3D, and SQLite readiness  |
| `/metrics`                                | simulation and send-queue metrics |
| `/world.bin`                              | immutable compiled map bundle     |
| `/box3d.wasm` and `/prediction-worker.js` | prediction runtime assets         |
| `/admin/reset`                            | authenticated world reset request |

Browser assets and gameplay share an origin, so no application CORS layer is
required. Administrative authorization remains server-side and never trusts UI
visibility.

## Container

The repository contains one multi-stage `Dockerfile`. Its build stage installs
the frozen Bun lockfile, runs tests, compiles maps, and builds browser/server
assets. Its runtime stage contains the minimum Bun runtime and generated output.

The image starts one command and one Bun process. `/data` is the only writable
persistent path. Production configuration uses `PORT`, `HOST`, `DATABASE_PATH`,
`PUBLIC_ORIGIN`, `ADMIN_TOKEN`, `STUN_URL`, `TURN_URL`, `TURN_USERNAME`,
`TURN_CREDENTIAL`, and `VOICE_RELAY_ONLY`. Startup validates ranges, URL schemes,
credential pairs, and production administration-token length before binding the
port. Secrets are never bundled into browser assets.
