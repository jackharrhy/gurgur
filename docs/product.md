# Product

Gurgur is a browser-based multiplayer 3D physics world authored in TrenchBroom.
It is minimalist, puzzle-friendly, persistent, and presented as one continuous
shared social place.

The shared physical state is the game. Players move through the same mechanisms,
loose bodies, constraints, and environmental changes. There are no inventories,
checkpoints, progression systems, matches, or permanently solved puzzles. An
authenticated administrator can reset the entire world to its authored state.

## Product rules

- One continuously running world, not matches, rooms, or server zones.
- Each browser controls and publishes its own player.
- A browser temporarily controls a prop only while Bun has granted it an
  exclusive grab lease.
- Bun controls unheld props, mechanisms, triggers, movers, diagnostic actors,
  identity, lifecycle, persistence, ownership grants, and global reset.
- Owner transforms are gameplay truth. Gurgur is a cooperative trusted-client
  social world, not a competitive shooter or anti-cheat boundary.
- Ordinary collision never transfers control of an object.
- TrenchBroom Valve 220 maps are the primary level-authoring format.
- Authored defaults and persisted runtime state remain distinct.
- A reset is global, explicit, authenticated, and visible to every client.
- Falling ten metres below authored static collision respawns the same player at
  `info_player_start` and publishes that discontinuity reliably.
- Ordinary play is the world canvas alone, with no HUD, reticle, or visible
  cursor. Pressing `T` temporarily opens speech input.
- Authored area music follows each listener independently and is not shared world
  state.
- Submitted speech is ephemeral audio only. It has no caption, history,
  persistence, or replay. Bun assigns speaker identity and voice.
- Realtime voice is outside the current product scope.

## Interaction feedback

The centered interaction ray provides world-space feedback without adding a HUD.
An available physics prop has a pulsing mint silhouette. A prop held by any peer
is not presented as available.

Pickup is a reliable request against the prop's current authority version. The
first valid request wins; a held prop cannot be stolen. The prop is carried from
its centre of mass toward a stable point in front of the owner. Walls shorten the
carry position, turning rotates the captured relative orientation, and bounded
linear/angular response keeps contact physical. Release reliably hands the
complete final pose and velocity back to Bun.

## Scope boundaries

Gurgur does not use Redis, microservices, distributed host election,
matchmaking, public user-generated content hosting, arbitrary mapper scripting,
procedural worlds, realtime voice, or account systems beyond the identity
required for administration and reconnect.

Puzzle completion is not durable state. Physical and mechanism state can persist,
but the authored world is always the reset baseline.

Text-to-speech is not a general text-chat system. `T` releases pointer lock and
neutralizes local movement while the field is active; Enter submits one
utterance and Escape cancels. Every browser synthesizes accepted text and plays
it from the speaker's current network position.
