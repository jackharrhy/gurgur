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
  main.ts               WebGPU capability gate and unsupported-browser view
  client.ts             gameplay client composition after WebGPU succeeds
  style.css
  session.ts            WebSocket control, WebRTC signaling, datagram dispatch
  ownership-client.ts   authority lifecycle and worker message bridge
  physics-worker.ts     60 Hz owned simulation and remote collision proxies
  presentation.ts       local-step and buffered remote interpolation
  renderer.ts           Three.js scene, camera, objects, render loop
  input.ts              keyboard, pointer lock, gamepad, touch intent
  speech-chat.ts        transient T-to-talk form and input capture
  speech-synthesis.ts   bounded synthesis queue and worker bridge
  speech-worker.ts      synchronous LinTalker JS/Wasm execution
```

`main.ts` requests a WebGPU adapter before importing the gameplay client. When
that capability is absent, it replaces the canvas with an accessible unsupported
message and does not request world content, assets, or a network session.
`client.ts` composes the modules but owns no simulation state. `session.ts` owns
network state. `renderer.ts` owns Three.js objects and `requestAnimationFrame`.
The shipped play page contains
only the world canvas during ordinary play: no HUD, reticle, visible cursor,
caption, or persistent control overlay. The transient `T` speech field is hidden
outside text entry and leaves no caption or history. `?test` enables a generic
read-only diagnostic object for browser
automation; ordinary play does not expose entity-specific instrumentation.
On non-production servers,
`?follow=<runtime-index>:<generation>&yaw=<radians>&pitch=<radians>` binds only
the presentation camera and pickup preview to a replicated runtime body. The
local network player's ownership and input do not change. The browser
accepts the follow request only after the server's
development capability route confirms it, reports acquisition through generic
body data attributes, and otherwise falls back to the ordinary local view.

## Three.js lifecycle

There is one renderer, scene, camera rig, and animation loop for the lifetime of
the play page. Map geometry is created from the compiled world bundle. Runtime
objects are keyed by generation-bearing runtime identity. Locally owned objects
interpolate consecutive completed 60 Hz worker steps. Remote objects render from
a 100 ms state buffer without extrapolation; the associated Box3D bodies remain
motion-disabled collision proxies.

Resizing updates renderer pixel ratio and camera projection. Losing visibility
pauses presentation and input transmission. Leaving the page closes the
WebSocket, RTCPeerConnection, data channels, speech worker, active speech sources, geometries,
materials, and renderer resources.
The canvas remains hidden against a black page until the renderer has followed a
finite locally owned player pose in the current frame. Loading a new world
closes that gate again, preventing a default-camera world frame from flashing
before the player view is known.
The third-person camera is a collision-tested boom anchored at the latest
presented player pose's head offset. A nine-ray, 0.18-metre-radius probe travels opposite
the player-controlled view toward the preferred 4.2-metre distance using a
dedicated double-sided collision mesh. Static collision includes invisible
`GURGUR/SKIP` faces; kinematic doors and platforms contribute their complete
moving brush geometry. Sensors, sprites, players, and loose dynamic props do not
move the camera.
Obstruction retracts the boom to its safe distance in the same frame. Clearance
holds the nearest position for 80 milliseconds, then expands with a
frame-rate-independent 180-millisecond half-life and no overshoot. Collision
never changes yaw, pitch, or field of view, and a presentation discontinuity
resets the boom before probing the new pose.

## Visual language

WebGPU is a required presentation capability. The application constructs
Three.js `Renderer` directly over `WebGPUBackend` without a WebGL fallback.
`RenderPipeline` and TSL own the shader graph; handwritten GLSL and the legacy
post-processing stack are excluded.
The world renders into a nearest-neighbour target capped at 480 x 270, then a TSL
resolve applies display-space RGB565 color quantization, a restrained
low-resolution-anchored 4 x 4 Bayer dither, and a pre-quantization vignette. This
preserves authored color detail while retaining the structured banding of a
late-1990s 16-bit software framebuffer. Surface textures retain nearest-neighbour
magnification but use mip levels under minification to prevent screen-scale moire
patterns.
The CSS canvas fills the viewport independently, preserving low-resolution pixels
without tying gameplay layout to a fixed window size.

World materials use authored, pixel-magnified PNG textures and native
`MeshLambertNodeMaterial` lighting. Typed ambient, directional, point, and spot
light capabilities drive Three.js lights; authored directional, point, and spot
lights may cast shadows. WebGPU shadow comparisons use Three.js's zero-bias
defaults; legacy normal offsets are not applied because they detach and truncate
contact shadows at brush corners. Interaction outline mask and hull meshes
explicitly neither cast nor receive shadows. The hashed asset manifest carries each material's real
PNG width and height so Valve 220 pixel-space UVs normalize identically for
default 64 x 64 tiles and larger TrenchBroom-fitted artwork.
Static and moving brush meshes preserve the compiler's outward triangle winding
and flat normals. Retro and reality brush materials render `FrontSide`, so the
GPU culls reverse-facing triangles; sprites and interaction outlines keep their
own presentation-specific sidedness.
World geometry uses ordinary unsnapped perspective projection, avoiding
silhouette gaps and unstable jagged edges. The low-resolution target, pixel
textures, palette resolve, and dither retain the retro character. Texture
coordinates remain perspective-correct to avoid camera-motion warping and
preserve player comfort without sacrificing texture mip levels.
Large concrete and stone surfaces use deterministic irregular aggregate instead
of periodic line grids, preventing grazing-angle moire without smoothing away the
pixel texture language.
Authored sky color sets both the composited background and fog. Water, caution,
danger, and platform materials animate UVs in TSL; water combines
two independently moving translucent samples and a slow palette pulse. Decorative
`env_sprite` point entities and player sprites are camera-facing, alpha-tested
mesh billboards. Non-glow billboards receive Lambert lighting and participate in
shadows; authored glow sprites remain additive and unlit.
Static world faces whose asset manifest mode is `reality` are mirrored into a
second scene and rendered at the canvas's native resolution with linear mip
sampling, authored Lambert lighting, no fog, no vertex snapping, and no palette
resolve. Non-shadowing light copies prevent a second complete shadow-map render
while ensuring those surfaces are no longer fullbright.
The result is intentionally uncanny: photographic detail remains conspicuously
real inside the otherwise software-rendered world. A separate low-resolution
occlusion pass supplies depth for the composite, so ordinary world geometry and
player billboards still cover reality surfaces correctly without requiring a
second full-resolution world render.
Finite point and spot lights may illuminate an authored world-sized volumetric
medium. The TSL pipeline renders Three.js `VolumeNodeMaterial` directly at the
same capped retro resolution with twelve ray-march steps and a Bayer offset, then
composes it before vignette and RGB565 quantization. It deliberately performs no
screen-space blur, so light cannot bleed across depth silhouettes. A cloned
layer-zero camera supplies a dedicated sampleable depth pass, keeping the medium
from sampling the main combined depth-stencil target or recursively rendering
itself.
The authored sky is composed beneath the transparent surface pass instead of
using `Scene.background`, so the volume pass clears to transparent black rather
than additively introducing a full-screen sky-color haze.
Ambient lights set the medium density; directional and ambient lights affect
surfaces but do not contribute volumetric scattering. Glow sprites remain a
deliberate unlit presentation exception.
Targetable physics props use a lightweight inverted-hull toon outline in the same
low-resolution scene pass. Mint means locally available; amber identifies a prop
owned by the local player's active grab lease.
Exact, colorless silhouettes first accumulate stencil coverage without testing
or changing world depth. The expanded hull then ignores world depth but draws
only where coverage remains zero, and player billboards render afterward against
the original world depth. Outlines therefore remain legible through level
geometry without filling the prop interior or drawing over a visible player.
Appending `?debug` enables the general diagnostic overlay. It renders the client
pickup cast using the same player-chest origin, view direction, and 3.25-metre
reach as Bun's grant validation: mint marks an available prop hit, blue marks an
interactive mechanism, and red marks a blocker, unavailable prop, or miss. It
also polls Bun's current Box3D debug frame at 10 Hz and draws broad-phase bounds,
joints, and contact points above the scene. The overlay is diagnostic only and
does not replace coordinator validation of ownership and reliable interactions.
Sprite presentation consumes only `PresentationSpec` and the hashed logical
sprite manifest; it never compares mapper classnames. The player billboard source
is a committed Blender scene sized to the shared
player collider. A code-defined 120-view latitude-ring rig covers camera elevation
from -75 through +75 degrees without oversampling the poles.
`bun run content -- setup-player-harness` rebuilds that rig in the saved scene;
`bun run content -- render-player` runs it headlessly and emits reproducible
views, a texture atlas, and metadata under `content/generated/`. The presentation
layer rotates the live 3D
player-to-camera vector into player-local space and selects the authored view with
the greatest dot product. The sprite quad is centered on the presented capsule
pose and uses the bake camera's exact orthographic dimensions.
Billboard source frames render at 64 x 64 with a single Eevee sample, temporal
reprojection disabled, a minimal reconstruction filter, and five constant
vertical-ambient color bands. Emission materials and the absence of directional
lights keep the baked lighting invariant around the player's azimuth; the runtime
palette pass then quantizes deliberately jagged, already stepped source art rather
than smoothing pristine 3D shading.
These choices are presentation rules rather than simulation constraints: physics,
interaction rays, map geometry, and network transforms remain full precision.

Per-listener area music consumes typed `play`/`stop` outputs from compiled
`trigger` entities targeting `ambient-audio` entity indices, without mapper
classname checks. The client tests its latest local player center against each
authored convex trigger brush, retains overlapping claims, and selects competing
music by priority and bundle order.
Playback uses Web Audio after the first player gesture, with authored crossfades
and hashed logical MP3 URLs under `content/audio`. Audio remains local
presentation: it adds no protocol message, network transform, or persisted
game state.

## Positional synthesized speech

`T` exits pointer lock, clears held keyboard, touch, and gamepad state, focuses a
120-character field, and leaves the 60 Hz local worker controller running with
zero movement and action intent. Enter validates and sends exactly once, then attempts to
restore pointer lock; failure keeps the existing click-to-lock fallback. Escape
cancels without sending. Invalid local text remains editable with a short status,
while server rejection produces only a temporary status.

Accepted text is synthesized independently by every browser. A dedicated classic
worker lazily imports the pinned Emscripten `WinTalker` factory and runs its
synchronous `wt_set_voice` and `wt_speak` calls away from rendering. It transfers
22.05 kHz mono signed-16-bit PCM back to the main thread. Output longer than
15 seconds is rejected. One active job and at most eight waiting jobs are
retained; when full, the oldest unstarted job is discarded. World replacement
increments a generation, clears waiting work, and discards any old result.

The renderer owns one `AudioListener` on the camera. Speech creates a
`PositionalAudio` at the current replicated player mesh's head offset, using
linear attenuation, a 2 m reference distance, 24 m maximum distance, rolloff 1,
and volume 0.75. The direct path remains dry. A second 0.12-gain branch passes
through one deterministic 350 ms exponential-noise convolver shared by speech
only; authored area music is unchanged. At most four speakers are active. New
speech fades the same speaker's prior source for 50 ms, and a fifth speaker
fades the oldest source. Player removal, world replacement, and page disposal
stop and disconnect their speech. PCM completed while autoplay is locked is
discarded instead of replayed later.

The vendored browser build is pinned to `dectalk/lintalker` commit
`5376b9ea76fe1fe86fecddd8b2b14f208ac64a21`. Source URL, hashes, and the
project-owner provenance decision are recorded in
[`../third_party/lintalker/README.md`](../third_party/lintalker/README.md) and
[decision 0018](decisions/0018-positional-lintalker-speech.md). The JS and Wasm
are copied into reproducible builds; `/assets.json` supplies SHA-256-addressed
URLs with immutable caching.

## Routes

The server exposes a deliberately small surface:

| Route                                       | Purpose                                |
| ------------------------------------------- | -------------------------------------- |
| `/` and SPA fallback                        | browser application                    |
| `/game`                                     | control/signaling WebSocket upgrade    |
| `/audio/<logical-id>.mp3?v=<sha256>`        | immutable authored audio asset         |
| `/lintalker.js?v=<sha256>`                  | pinned synthesis factory               |
| `/lintalker.wasm?v=<sha256>`                | pinned synthesis engine                |
| `/speech-worker.js`                         | off-main-thread synthesis bridge       |
| `/physics-worker.js`                        | owned Box3D simulation worker          |
| `/healthz`                                  | process and event-loop health          |
| `/readyz`                                   | map, Box3D, and SQLite readiness       |
| `/metrics`                                  | simulation and send-queue metrics      |
| `/debug/physics`                            | bounded current Box3D debug frame      |
| `/debug/client-capabilities`                | development client presentation gates  |
| `/world.bin`                                | immutable compiled map bundle          |
| `/box3d.wasm`                               | Box3D diagnostic/runtime artifact      |
| `/player-billboard.png`                     | generated directional player atlas     |
| `/assets.json`, `/textures/*`, `/sprites/*` | hashed authored material/sprite assets |
| `/admin/reset`                              | authenticated world reset request      |

Browser assets and gameplay share an origin, so no application CORS layer is
required. Administrative authorization remains server-side and never trusts UI
visibility.

The development MCP endpoint is deliberately absent from this route table: it
uses a separate loopback-only listener inside the same Bun process. Development
defaults to port `9237`; `GURGUR_DEV_MCP_PORT` changes it and
`GURGUR_DEV_MCP=0` disables it. Production ignores those development defaults
and cannot enable the listener.

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
whether keyboard intent is sampled. Speech text entry is the one temporary
adjacent focus target. The canvas suppresses the browser's native focus outline;
focus itself remains intact. The browser accepts the server RTC offer and uses
the dynamically supplied ICE configuration when creating its peer.

GitHub Actions builds this Dockerfile on pushes to `main`, version tags, and
manual dispatches, then publishes it to `ghcr.io/<owner>/<repository>`. The
default branch publishes `latest`; all builds retain source-ref and commit-SHA
tags, while version tags also publish normalized semantic-version tags.
