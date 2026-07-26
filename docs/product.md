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
- The client owns input sampling and rendering of authoritative shared state.
- TrenchBroom Valve 220 maps are the primary level-authoring format.
- Authored defaults and persisted runtime state remain distinct.
- A reset is global, explicit, authenticated, and visible to every client.
- Falling ten metres below authored static collision respawns the same player
  identity at `info_player_start`.
- Ordinary play is the world canvas alone, with no HUD, reticle, or visible
  cursor. Pressing `T` temporarily opens the speech input.
- Authored area music follows each listener independently and fades with typed
  map volumes; it is not shared authoritative world state.
- Submitted speech is ephemeral audio only: it has no caption, history,
  persistence, or replay. The server owns speaker identity and voice assignment.
- Realtime voice is outside the current product scope.

## Interaction feedback

The centered interaction ray provides world-space feedback without adding a HUD.
An unowned physics prop that is locally targetable has a pulsing mint silhouette.
After the server accepts a grab, that prop keeps an amber silhouette even when
the player looks away; the outline clears only when authoritative state reports
release. Props held by another player are not presented as available.

A held prop is pulled to a stable point in front of the player rather than
tethered at its pickup distance. Turning moves that point with the view without
letting the prop orbit the player; walls shorten the carry position, and bounded
linear and angular response keeps collisions physical. A persistently blocked or
lost prop releases instead of accumulating unbounded force.

## Scope boundaries

Gurgur does not use Redis, microservices, distributed simulation, matchmaking,
public user-generated content hosting, arbitrary mapper scripting, procedural
worlds, realtime voice, or account systems beyond the identity required for
administration and reconnect.

Puzzle completion is not durable state. Physical and mechanism state can persist,
but the authored world is always the reset baseline.

Text-to-speech is not a general text-chat system. `T` releases pointer lock and
neutralizes gameplay intent while the field is active; Enter submits one
utterance and Escape cancels. Every browser synthesizes accepted text and plays
it from the speaker's current player position. The transient field and brief
validation status are the only interface.
