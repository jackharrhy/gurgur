# Product

Gurgur is a browser-based multiplayer 3D physics world authored in TrenchBroom.
It is minimalist, puzzle-friendly, persistent, and presented as one continuous
shared place.

The shared physical state is the game. Players move through the same mechanisms,
loose bodies, constraints, and environmental changes. There are no inventories,
checkpoints, progression systems, matches, or permanently solved puzzles. An
authenticated administrator can reset the entire world to its authored state.

## Product rules

- One continuously running world, not matches, rooms, or server zones.
- The server owns players, bodies, constraints, mechanisms, persistence, and reset.
- The client owns input sampling, local-player prediction, and rendering of
  authoritative shared state.
- TrenchBroom Valve 220 maps are the primary level-authoring format.
- Authored defaults and persisted runtime state remain distinct.
- A reset is global, explicit, authenticated, and visible to every client.
- Falling ten metres below authored static collision respawns the same player
  identity at `info_player_start`.
- The play view is the world canvas alone, with no HUD, reticle, or visible cursor.
- Realtime voice is outside the current product scope.

## Interaction feedback

The centered interaction ray provides world-space feedback without adding a HUD.
An unowned physics prop that is locally targetable has a pulsing mint silhouette.
After the server accepts a grab, that prop keeps an amber silhouette even when
the player looks away; the outline clears only when authoritative state reports
release. Props held by another player are not presented as available.

## Scope boundaries

Gurgur does not use Redis, microservices, distributed simulation, matchmaking,
public user-generated content hosting, arbitrary mapper scripting, procedural
worlds, realtime voice, or account systems beyond the identity required for
administration and reconnect.

Puzzle completion is not durable state. Physical and mechanism state can persist,
but the authored world is always the reset baseline.
