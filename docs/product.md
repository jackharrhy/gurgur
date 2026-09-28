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
- Each browser sends player intent; Bun simulates every player.
- Bun dynamically simulates every shared prop, whether held or unheld.
- A browser predicts its player, a confirmed held loose prop, and a bounded
  server-selected nearby loose-body set. Explicit contraption manipulation may
  publish a disposable target under an exclusive claim.
- Bun controls shared rigid bodies, mechanisms, triggers, movers, diagnostic
  actors, identity, lifecycle, persistence, claims, and global reset.
- Jointed contraptions are host-fixed compositions. Players can push their
  parts, operate authored motors, and directly pull one part through an
  exclusive host-side manipulation claim. The part never leaves the graph's
  authority.
- Maps may compose levers, sliders, ball sockets, ropes, springs, welded
  assemblies, conveyors, gravity areas, and machines such as trebuchets from a
  small Source-style physics vocabulary.
- Bun's player and rigid-body transforms are gameplay truth. Browser prediction
  is corrected from authoritative checkpoints.
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
An available fixed contraption part uses the same silhouette and becomes amber
for its local manipulator. Ball sockets, hinges, motors, sliders, ropes, rods,
springs, and welds have authored-on-by-default physical markers derived from
their live attachment frames.

Loose pickup is an input-command edge validated against Bun's player pose and
view. The first valid claim wins; a held prop cannot be stolen. Once Bun confirms
the claim, the browser predicts the same bounded grab controller and dynamic
body as Bun. Walls shorten the carry target and turning rotates the captured
relative orientation. Checkpoints restore and replay the prediction. Release
stops the grab drive, preserving the body's physical velocity, and is predicted
from the releasing command. Bun remains authoritative throughout.

Direct contraption manipulation uses a reliable claim request and disposable
target updates. The browser selects the hit point instead of the centre of mass.
Bun's native control joint pulls that point while simulating the complete
machine; jointed bodies never enter browser prediction.

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
