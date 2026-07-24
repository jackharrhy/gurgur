# Gurgur entity contract

## Ownership

| Concern                                                                                                                    | Owner             |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Valve 220 parsing, geometry, physics, generic capabilities, binary envelope, protocol                                      | `packages/engine` |
| Mapper catalog, compiled union/decoder, typed compilation, players, controller, interactions, simulation, game-state codec | `packages/game`   |
| Fixed stepping, body construction, transactions, replication, metrics                                                      | `apps/server`     |
| Presentation capabilities and asset loading                                                                                | `apps/web`        |

Mapper classnames may occur in the game catalog/compiler and compiler
diagnostics only.

## Authored definition

An `EntityProperty<T>` owns editor metadata and parses one raw string into `T`.
`InferProperties` gives the compile callback typed values. An
`EntityDefinition` contains one editor record, one consolidated property
schema, and one explicit compile callback.

Use the helpers in `packages/game/src/entities.ts` for strings, bounded
numbers, booleans, vectors, colors, targets, target names, map distances, map
speeds, yaw angles, and logical sprite IDs. Do not recreate conversions in a
catalog entry.

Persistent definitions receive `context.authoredId`. The compiler validates
uniqueness, target resolution, exactly one worldspawn, unique player spawn
names, and exactly one `default` spawn.

## Compiled vocabulary

`CompiledGameEntity` and its strict structural decoder live together in
`packages/game/src/world.ts`. The closed union is:

- `physics-prop`
- `linear-mover` with `door` or `platform` mode
- `trigger` with `once` or `multiple` mode
- `relay`
- `button`
- `sprite`

Every member declares body, presentation, and interaction capabilities. Special
authored entities compile into `settings`, `playerSpawns`, or `resetMarkers`
instead of the entity array.

Do not add a new union member for a cosmetic mapper alias. Add a member only
when simulation or persistence semantics differ.

## Runtime and persistence

The network references a compiled entity by immutable bundle index. Never send
authored IDs, classnames, property strings, or brush lists in lifecycle
records. Harness-created clones may share an entity index.

`GameEngine` is the only game-facing host capability. It intentionally omits
physics stepping, disposal, debug extraction, and arbitrary body creation.

Persist mechanism state through `PersistedGameState` in
`packages/game/src/state.ts`. Its JSON decoder is strict and rejects unknown
kinds, fields, duplicate IDs, and malformed ticks. Player lifecycle and
structured player state belong to `GameSimulation.players`; the server persists
the returned records without owning their gameplay semantics.
`GameSimulation.persistedState()` is the single entity-gameplay serialization
boundary; do not enumerate game union members in the server.

## Extension checklist

### Content using an existing entity

- Edit a non-autosave `.map` or add `content/sprites/<logical-id>.png`.
- Compile content and inspect deterministic generated artifacts.
- Do not touch engine, protocol, renderer dispatch, or simulation.

### Mapper entity using an existing archetype

- Add one catalog definition with typed properties and `compile`.
- Reuse an existing archetype/capability.
- Add required/default/conversion and target-resolution tests.
- Regenerate the FGD, game config, and world bundle.

### New gameplay behavior

- Extend the union and strict decoder in `packages/game/src/world.ts`.
- Add simulation behavior through `GameEngine`.
- Extend `PersistedGameState` only if behavior survives restarts.
- Add compiler, simulation, persistence, and presentation tests as applicable.
- Confirm transport remains bundle-index based; a new classname never requires
  a protocol tag.
