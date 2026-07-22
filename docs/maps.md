# Maps and world compilation

## Authored truth

TrenchBroom Valve 220 `.map` files and the TypeScript entity schema are the only
authored world truth. Maps contain geometry, materials, entity instances, and
authored defaults. The TypeScript schema defines legal classnames, properties,
types, defaults, and runtime construction behavior.

Generated meshes, collision data, FGD files, TrenchBroom game configuration, and
runtime bundles are reproducible build artifacts. They are never edited by hand.

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

The compiler applies the canonical transform and unit scale exactly once:

```text
map (x, y, z) -> world (x, z, -y) * 0.0254 metres
```

Valve 220 UV projection remains in authored map space. Render vertices, collision
vertices, entity origins, directions, rotations, and dimensions all derive from
the same validated brush representation. Every generated triangle retains its
source entity, brush, face, and material identity.

## Runtime bundle

One source map compiles into one immutable world bundle containing:

- material-grouped Three.js vertex/index/UV/normal buffers;
- Box3D static indexed-mesh data and convex data for moving brushes;
- typed runtime entity definitions and authored defaults;
- spawn points and persistent `authoredId` values;
- source-to-generated diagnostic tables;
- compiler/schema versions and SHA-256 `mapRevision`.

Serialization uses explicit versioned binary sections with deterministic ordering.
The same sources, schema, and compiler version produce byte-identical bundles.
Runtime startup rejects an unsupported bundle version before creating the world.

## Entity schema

The base schema contains:

| Class | Purpose |
| --- | --- |
| `worldspawn` | world metadata, gravity, materials, environment |
| `info_player_start` | player spawn transform |
| `func_physics` | dynamic convex brush body |
| `func_door` | kinematic door mechanism |
| `func_platform` | kinematic moving platform |
| `trigger_once` | one-shot sensor event |
| `trigger_multiple` | repeatable sensor event |
| `logic_relay` | typed mechanism signal relay |
| `func_button` | physical/use-activated signal source |
| `info_world_reset` | authenticated administrative reset marker |
| `env_sprite` | camera-facing render-only pixel-art prop |

The schema drives compiler validation, FGD generation, and the TrenchBroom game
configuration. The authoritative server constructs the corresponding runtime
registries from the validated compiled entities. Properties are typed and
composable; arbitrary mapper scripts and runtime code strings are forbidden.

Every entity whose state can persist requires a unique explicit `authoredId`.
Compilation fails on missing or duplicate persistent IDs. Entity order, line
number, and runtime network identity are never persistence keys.

The executable base schema lives in `packages/entity-schema`. It is the source
for compiler validation and the generated `content/trenchbroom/Gurgur.fgd`.
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
