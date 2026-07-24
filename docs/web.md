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
  session.ts            WebSocket control, WebRTC signaling, datagram dispatch
  prediction-worker.ts  Box3D worker entrypoint
  prediction-client.ts  worker ownership and message bridge
  prediction.ts         replay and reconciliation implementation
  presentation.ts       fixed-pose/display-frame smoothing
  renderer.ts           Three.js scene, camera, objects, render loop
  interpolation.ts      remote snapshot histories and visual sampling
  input.ts              keyboard, pointer lock, gamepad, touch intent
```

`main.ts` composes the modules but owns no simulation state. The prediction worker
owns predicted physics. `session.ts` owns network state. `renderer.ts` owns
Three.js objects and `requestAnimationFrame`. The shipped play page contains only
the world canvas: no HUD, reticle, visible cursor, caption, or control overlay.
`?test` enables a generic read-only diagnostic object for browser automation;
ordinary play does not expose entity-specific instrumentation.

## Three.js lifecycle

There is one renderer, scene, camera rig, and animation loop for the lifetime of
the play page. Map geometry is created from the compiled world bundle. Runtime
objects are keyed by generation-bearing network identity. Each frame samples
interpolated visual transforms from client state and applies them directly to
Three.js objects.

Resizing updates renderer pixel ratio and camera projection. Losing visibility
pauses presentation and input transmission without advancing local physics by
elapsed wall time. Leaving the page closes the WebSocket, RTCPeerConnection,
data channels, prediction worker, geometries, materials, and renderer resources.

## Visual language

Three.js `WebGPURenderer` remains the scene and presentation backend, using its
WebGL 2 fallback when WebGPU is unavailable. `RenderPipeline` and TSL own the
shader graph; handwritten GLSL and the legacy post-processing stack are excluded.
The world renders into a nearest-neighbour target capped at 480 x 270, then a TSL
resolve applies display-space RGB565 color quantization, a restrained
low-resolution-anchored 4 x 4 Bayer dither, and a pre-quantization vignette. This
preserves authored color detail while retaining the structured banding of a
late-1990s 16-bit software framebuffer. Surface textures retain nearest-neighbour
magnification but use mip levels under minification to prevent screen-scale moire
patterns.
The CSS canvas fills the viewport independently, preserving low-resolution pixels
without tying gameplay layout to a fixed window size.

World materials use authored, pixel-magnified PNG textures and shadow-map-free
Gouraud lighting explicitly evaluated in TSL's vertex stage. The hashed asset
manifest carries each material's real PNG width and height so Valve 220
pixel-space UVs normalize identically for default 64 x 64 tiles and larger
TrenchBroom-fitted artwork.
Clip-space vertex snapping and partially affine UV interpolation provide
controlled software-renderer instability without sacrificing texture mip levels.
Large concrete and stone surfaces use deterministic irregular aggregate instead
of periodic line grids, preventing grazing-angle moire without smoothing away the
pixel texture language.
Authored sky color sets both scene background and fog. Water, caution, danger,
and platform materials animate UVs in TSL; water combines
two independently moving translucent samples and a slow palette pulse. Decorative
`env_sprite` point entities and player sprites are camera-facing pixel billboards.
Static world faces whose asset manifest mode is `reality` are mirrored into a
second scene and rendered at the canvas's native resolution with linear mip
sampling, no fog, no vertex snapping, no retro lighting, and no palette resolve.
The result is intentionally uncanny: photographic detail remains conspicuously
real inside the otherwise software-rendered world. A separate low-resolution
occlusion pass supplies depth for the composite, so ordinary world geometry and
player billboards still cover reality surfaces correctly without requiring a
second full-resolution world render.
Targetable physics props use a lightweight inverted-hull toon outline in the same
low-resolution scene pass: mint means locally available, while amber is driven by
the server-authoritative local-grab flag. This avoids a separate full-scene
outline compositor and keeps WebGPU and WebGL fallback presentation identical.
Exact, colorless silhouettes first accumulate stencil coverage without testing
or changing world depth. The expanded hull then ignores world depth but draws
only where coverage remains zero, and player billboards render afterward against
the original world depth. Outlines therefore remain legible through level
geometry without filling the prop interior or drawing over a visible player.
Appending `?debug` enables the general diagnostic overlay. It renders the client
pickup cast using the same player-chest origin, view direction, and 3.25-metre
reach as server validation: mint marks an available prop hit, blue marks an
interactive mechanism, and red marks a blocker, unavailable prop, or miss. It
also polls the current authoritative Box3D debug frame at 10 Hz and draws
broad-phase bounds, joints, and contact points above the scene. The overlay is
diagnostic only and does not replace authoritative server interaction validation.
Sprite presentation consumes only `PresentationSpec` and the hashed logical
sprite manifest; it never compares mapper classnames. The player billboard source
is a committed Blender scene sized to the authoritative
player collider. A code-defined 120-view latitude-ring rig covers camera elevation
from -75 through +75 degrees without oversampling the poles.
`bun run content -- setup-player-harness` rebuilds that rig in the saved scene;
`bun run content -- render-player` runs it headlessly and emits reproducible
views, a texture atlas, and metadata under `content/generated/`. The presentation
layer rotates the live 3D
player-to-camera vector into player-local space and selects the authored view with
the greatest dot product. The sprite quad is centered on the authoritative capsule
pose and uses the bake camera's exact orthographic dimensions.
Billboard source frames render at 64 x 64 with a single Eevee sample, temporal
reprojection disabled, a minimal reconstruction filter, and five constant
vertical-ambient color bands. Emission materials and the absence of directional
lights keep the baked lighting invariant around the player's azimuth; the runtime
palette pass then quantizes deliberately jagged, already stepped source art rather
than smoothing pristine 3D shading.
These choices are presentation rules rather than simulation constraints: physics,
interaction rays, map geometry, and network transforms remain full precision.

## Routes

The server exposes a deliberately small surface:

| Route                                       | Purpose                                |
| ------------------------------------------- | -------------------------------------- |
| `/` and SPA fallback                        | browser application                    |
| `/game`                                     | control/signaling WebSocket upgrade    |
| `/healthz`                                  | process and event-loop health          |
| `/readyz`                                   | map, Box3D, and SQLite readiness       |
| `/metrics`                                  | simulation and send-queue metrics      |
| `/debug/physics`                            | bounded current Box3D debug frame      |
| `/world.bin`                                | immutable compiled map bundle          |
| `/box3d.wasm` and `/prediction-worker.js`   | prediction runtime assets              |
| `/player-billboard.png`                     | generated directional player atlas     |
| `/assets.json`, `/textures/*`, `/sprites/*` | hashed authored material/sprite assets |
| `/admin/reset`                              | authenticated world reset request      |

Browser assets and gameplay share an origin, so no application CORS layer is
required. Administrative authorization remains server-side and never trusts UI
visibility.

## Container

The repository contains one multi-stage `Dockerfile`. Its build stage installs
the frozen Bun lockfile, runs tests, compiles maps, and builds browser/server
assets. Its runtime stage contains the minimum Bun runtime and generated output.

The image starts one command and one Bun process. `/data` is the only writable
persistent path. Production configuration uses `PORT`, `HOST`, `DATABASE_PATH`,
`PUBLIC_ORIGIN`, `ADMIN_TOKEN`, `RTC_PORT_MIN`, `RTC_PORT_MAX`,
`RTC_ADDITIONAL_HOST_IPS`, and optional `RTC_ICE_SERVERS_JSON`. Startup validates
HTTP/UDP ranges, IPs, ICE server schemes, URL schemes, and production
administration-token length before binding. The deployment publishes the
configured UDP range and supplies TURN when direct candidates are not reachable.
Secrets are never bundled into browser assets.

The world canvas is keyboard-focusable. Movement remains available when pointer
lock is denied or unavailable; pointer lock controls relative mouse look, not
whether keyboard intent is sampled. The browser accepts the server RTC offer and
uses the dynamically supplied ICE configuration when creating its peer.

GitHub Actions builds this Dockerfile on pushes to `main`, version tags, and
manual dispatches, then publishes it to `ghcr.io/<owner>/<repository>`. The
default branch publishes `latest`; all builds retain source-ref and commit-SHA
tags, while version tags also publish normalized semantic-version tags.
