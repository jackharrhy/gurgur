# 0016: Required WebGPU backend and typed volumetric lighting

Status: accepted, 2026-07-25.

## Decision

The browser requires WebGPU. Startup acquires an adapter before importing the
gameplay client, and unsupported browsers receive a static explanation without
loading world content or opening a network session. Three.js uses `Renderer`
directly over `WebGPUBackend`; there is no WebGL fallback presentation path.

TrenchBroom exposes ambient, directional, point, and spot mapper entities. They
compile into one generic, closed light presentation capability rather than
passing mapper classnames to the renderer. Ordinary world and non-glow billboard
materials use native Lambert lighting, and authored finite or directional lights
may cast shadows.

Volumetric lighting follows Three.js's WebGPU volume-lighting design:
`VolumeNodeMaterial` receives finite point and spot lights and their shadows in
an unfiltered pass aligned to the capped retro resolution and composed before the
retro palette resolve. Ambient light authors medium density. Infinite ambient
and directional lights do not contribute volume scattering. Native-resolution
reality surfaces receive non-shadowing copies of the authored lights so their
texture detail remains distinct without becoming fullbright.
The main scene keeps a transparent background and composes authored sky color
beneath its surface pass; this prevents the additive volume pass from treating a
background clear as scattering.

## Alternatives

A dual WebGPU/WebGL presentation path was rejected because it would require
maintaining two materially different shader, shadow, and volume implementations.
The former hardcoded vertex-light approximation was rejected because it could
not represent authored lights, occlusion, or shadows. Passing raw light
classnames into browser dispatch was rejected because mapper vocabulary must
stop at the compiler boundary.

## Evidence

The implementation is based on the pinned Three.js r185 WebGPU volume-lighting
example and APIs. Codec, entity-catalog, compiler, material, light-construction,
and startup-gate tests cover the production contracts. Browser movement and grab
scenarios require the real WebGPU backend; a separate unsupported scenario proves
that the gameplay client does not load when WebGPU is absent.
