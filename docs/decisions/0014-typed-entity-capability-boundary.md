# 0014: Compile mapper entities into game-owned capabilities and bundle indices

Status: accepted on 2026-07-23.

Gurgur compiles each TrenchBroom classname and its raw string properties through
one typed catalog in `packages/game`. Special authored records become world
settings, player spawns, or reset markers. Remaining records become members of a
closed, game-owned `CompiledGameEntity` union whose members explicitly declare
generic body, presentation, and interaction capabilities.

The engine owns Valve parsing, math, physics, generic capabilities, geometry,
the binary bundle envelope, and protocol codecs. It does not own the gameplay
union or its strict decoder. Game simulation receives only the narrow
`GameEngine` host capability. This lets content authors add mapper aliases using
an existing archetype without touching simulation, renderer dispatch, physics,
or transport; genuinely new behavior extends the game union, decoder,
simulation, and persisted game state together.

Runtime actors refer back to immutable compiled content by `entityIndex`.
Lifecycle records contain only their source tag, generation-bearing runtime ID,
and entity index, with a reserved sentinel for players. Harness clones may share
an entity index. Mapper classnames, authored IDs, raw properties, brush lists,
and source positions do not cross the runtime/network boundary.

Alternatives rejected:

- Raw classname/property bags spread mapper concerns across physics, networking,
  persistence, and rendering and make authoring require engine knowledge.
- Per-entity lifecycle callbacks hide ordering and persistence behavior behind
  an extensibility framework.
- An ECS introduces a second general-purpose runtime model without solving the
  authoring boundary.
- Putting the closed gameplay union in `engine` makes every new gameplay
  capability an engine change and fails the intended high-level extension path.
- Protocol tags per mapper classname couple content vocabulary to wire
  compatibility even though the immutable bundle already defines each actor.

The clean-start v1 bundle/protocol rollout intentionally has no legacy decoder,
schema migration, adapter, negotiation, or compatibility path. Generated
content is rebuilt and persisted data is wiped before rollout.

Evidence lives in catalog/compiler/codec tests, game simulation and persistence
tests, protocol lifecycle tests, renderer/browser scenarios, the network
harness, and the forward-tested `extend-gurgur-entities` repository skill.
