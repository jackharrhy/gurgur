---
name: extend-gurgur-entities
description: Add or modify Gurgur map content, typed mapper entities, compiled gameplay archetypes, entity simulation, presentation, and persisted gameplay state. Use for TrenchBroom entity work, new map entity classnames, entity properties, sprites, mechanisms, signals, interactions, or any request to extend gameplay without leaking mapper concepts into the engine, renderer, or network protocol.
---

# Extend Gurgur Entities

Treat the TypeScript catalog and Valve 220 maps as authored truth. Keep content
work approachable: use an existing compiled capability whenever it can express
the requested behavior.

Read `references/entity-contract.md` before changing code.

## Choose the smallest extension

1. **Content only** — Edit maps or add PNG assets using an existing catalog
   entity. Do not change `packages/engine`, transport, renderer dispatch, or
   gameplay simulation.
2. **New mapper entity, existing archetype** — Add one consolidated catalog
   entry in `packages/game/src/entities.ts`. Parse typed properties and compile
   directly to an existing closed archetype. Do not add classname checks
   elsewhere.
3. **New gameplay capability** — Extend the compiled union deliberately, then
   update its strict decoder in `packages/game/src/world.ts`, the simulation,
   persisted state when needed, and focused tests. Extend a generic presentation
   or physics capability only when the existing capability vocabulary cannot
   express the behavior. Do not change transport merely to identify the new
   entity.

If uncertain between levels, prove why the lower level is insufficient before
choosing the next.

## Implement

- Keep all mapper classnames and editor metadata in
  `packages/game/src/entities.ts`.
- Use property helpers. Required data must fail with a source diagnostic;
  optional data must be explicitly optional; defaults must be authored
  metadata.
- Let `persistent: true` inject `authoredId`; never add it manually to an
  entity's property schema.
- Compile raw properties immediately into a typed archetype. Never place raw
  property bags, mapper classnames, or source locations in `WorldBundle`.
- Reuse `BodySpec`, `PresentationSpec`, and `InteractionSpec`. Runtime and wire
  identity is `{ id, kind: "world-entity", entityIndex }`.
- Put player lifecycle, interactions, gameplay rules, controller policy, signal
  handling, and gameplay-state validation in `packages/game`.
- Keep `packages/engine` generic. Do not add entity lifecycle callbacks, an ECS,
  mapper scripting, or arbitrary game-facing body construction.
- For sprites, commit a PNG under `content/sprites` and use a validated
  extensionless logical ID.

## Verify

Add focused catalog/compiler tests for authored validation and focused game
tests for behavior and persistence. Run:

```bash
bun run content -- compile
bun run typecheck
bun run test
bun run check
```

Also run `bun run test:browser -- <scenario>` for presentation/interaction
changes and `bun run test:network -- matrix --quick` when prediction,
replication, or runtime references are affected. Run the relevant soak profile
for lifecycle or persistence changes.

Update canonical behavior in the authoritative document named by `AGENTS.md`.
Put sequencing and completion status only in `docs/work.md`. Add a decision
record only for a durable architectural choice.
