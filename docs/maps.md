# Maps and world compilation

## Authored truth

TrenchBroom Valve 220 `.map` files and the TypeScript entity schema are the only
authored world truth. Maps contain geometry, materials, entity instances, and
authored defaults. The TypeScript schema defines legal classnames, properties,
types, defaults, and runtime construction behavior.

Material PNGs under `content/textures` and decorative PNGs under
`content/sprites` are authored assets. Sprite names are validated extensionless
logical IDs. Generated meshes, collision data, FGD files, TrenchBroom game
configuration, manifests, and runtime bundles are reproducible build artifacts.
They are never edited by hand.

## TrenchBroom setup

Run `bun run content -- setup` after cloning or whenever the entity schema or
game configuration changes. The command first performs `content -- compile`,
then installs the generated FGD and game
configuration, validates the authored material collection, installs the game
configuration in the current operating system's TrenchBroom user-data directory,
and configures this repository's `content` directory as the Gurgur game path
without discarding other TrenchBroom preferences. Restart TrenchBroom after
installation.

Gurgur maps identify themselves with `// Game: Gurgur` and `// Format: Valve`
header comments so TrenchBroom selects the installed game and Valve 220 format
automatically. Runtime and editor rendering use the same authored PNGs; default
materials are 64 x 64 and new TrenchBroom faces use a 0.5 texture scale, but
materials and per-face scales may use other dimensions. TrenchBroom loads the
texture collection from `content/textures/GURGUR` through the configured game path.
Configuration generation validates that every mapped material has an authored
PNG and never creates or overwrites artwork.

Materials under `GURGUR/REAL/*` opt static world faces into the native-resolution
reality-break presentation described in `docs/web.md`. Existing
`GURGUR/dylans*` materials use the same mode as a temporary compatibility
convention. The generated TrenchBroom configuration exposes both patterns as
brush-face smart tags so authors can select and filter them in the editor. Valve
220 itself has no arbitrary per-face presentation metadata, so the material
namespace is the authored contract; new content should use `GURGUR/REAL/*`.

The installer follows TrenchBroom's platform user-data locations. Set
`TRENCHBROOM_USER_DATA_PATH` only for a portable or otherwise nonstandard
installation.

## Parser

Gurgur owns a small scanner and parser for the required Valve 220 grammar. It
supports quoted entity properties, point and brush entities, convex brushes,
three-point face planes, material names, explicit U/V axes, offsets, rotation,
scale, and TrenchBroom comments.

Every syntax and semantic node retains file, line, column, entity, brush, and face
identity. Malformed tokens, non-finite values, degenerate planes, empty brushes,
and invalid entity properties fail compilation with those source coordinates.

## Brush compilation

For each convex brush, the compiler orients every face plane toward the brush
interior, intersects plane triplets, retains points inside all half-spaces,
deduplicates vertices, sorts each face around its normal, and triangulates it with
a stable fan. Epsilon policy and sort order are fixed so identical inputs produce
identical output.

Valve face-defining points establish an infinite plane and need not lie inside the
eventual clipped face. The compiler therefore never guesses an interior point by
averaging them. It tests the authored winding and its complete reversal, accepting
the orientation only when it produces a closed convex volume in which every plane
contributes a face. This supports globally mirrored TrenchBroom brushes without
accepting mixed-winding or open geometry.

The compiler applies the canonical transform and unit scale exactly once:

```text
map (x, y, z) -> world (x, z, -y) * 0.0254 metres
```

Valve 220 UV projection remains in authored map space. Each component is
`dot(axis, point) / scale + shift`; the renderer then normalizes U by the
authored PNG width and negates and normalizes V by its height. Non-default
TrenchBroom axes, offsets, rotations, and scales are preserved per face. Render
vertices, collision vertices, entity origins, directions, rotations, and
dimensions all derive from the same validated brush representation. Every
generated triangle retains its source entity, brush, face, and material identity.

## Runtime bundle

One source map compiles into one immutable world bundle containing:

- material-grouped Three.js vertex/index/UV/normal buffers;
- Box3D static indexed-mesh data and convex data for moving brushes;
- typed game entities with explicit body, presentation, and interaction
  capabilities;
- world settings, uniquely named player spawns, reset markers, and persistent
  `authoredId` values;
- a SHA-256 `mapRevision`.

Serialization uses a v1 binary envelope with deterministic, unversioned sections.
The same sources, schema, and compiler produce byte-identical bundles. Runtime
startup rejects a non-v1 bundle before creating the world; there are no legacy
bundle decoders.

## Entity schema

The base schema contains:

| Class               | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `worldspawn`        | world metadata, gravity, materials, environment |
| `info_player_start` | player spawn transform                          |
| `func_physics`      | dynamic convex brush body                       |
| `func_door`         | kinematic door mechanism                        |
| `func_platform`     | kinematic moving platform                       |
| `trigger_once`      | one-shot sensor event                           |
| `trigger_multiple`  | repeatable sensor event                         |
| `logic_relay`       | typed mechanism signal relay                    |
| `func_button`       | physical/use-activated signal source            |
| `info_world_reset`  | authenticated administrative reset marker       |
| `env_sprite`        | camera-facing render-only pixel-art prop        |

The schema drives compiler validation, FGD generation, and the TrenchBroom game
configuration. The authoritative server constructs the corresponding runtime
registries from the validated compiled entities. Properties are typed and
composable; arbitrary mapper scripts and runtime code strings are forbidden.

Compilation requires exactly one `worldspawn`, at least one uniquely named
player spawn, and exactly one spawn named `default`. Authored gravity drives
authoritative and predicted physics/controller behavior; authored sky color
drives renderer background and fog. Every `target` must resolve, while multiple
recipients may intentionally share a `targetname`.

Every entity whose state can persist requires a unique explicit `authoredId`.
Compilation fails on missing or duplicate persistent IDs. Entity order, line
number, and runtime network identity are never persistence keys.

The `bun run content -- compile` entrypoint assigns UUID-backed `authoredId` values to
new persistent entities that TrenchBroom created without one and atomically writes
them into the source map before compiling. The compiler API remains strict: a map
passed directly to `compileWorld` must already contain complete, unique IDs. This
keeps generated identity persistent without making entity order or geometry an
implicit persistence key.

The executable catalog lives in `packages/game/src/entities.ts`; the compiled
gameplay union and strict decoder live in `packages/game/src/world.ts`. They are
the source for compiler validation and the generated
`content/trenchbroom/Gurgur.fgd`. Mapper classnames and raw map properties do not
enter the runtime bundle; source identity survives only in compiler diagnostics.
Mechanisms use typed `targetname`/`target` signal links. Doors and platforms use
map-space `moveDirection`, map-unit `distance` and `speed`, endpoint `wait`, and
`startOpen`. Dynamic bodies author density, friction, and restitution. Relays
author delay and one-shot behavior; triggers and buttons only emit signals.

Navigation meshes are not part of Gurgur's runtime or bundle format. If navigation
becomes product scope, it must be generated from this compiler's collision
surface and versioned independently from authored truth.

`env_sprite` is deliberately render-only. Its map-space origin, sprite name,
height, and glow flag compile into the immutable bundle, but the authoritative
server creates no body, mechanism, persistence record, or runtime identity for it.
