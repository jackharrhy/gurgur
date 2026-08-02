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
- Bun dynamically simulates every shared prop, whether held or unheld.
- A browser controls only its player and may publish a disposable target under
  an exclusive prop-manipulation claim.
- Bun controls shared rigid bodies, mechanisms, triggers, movers, diagnostic
  actors, identity, lifecycle, persistence, claims, and global reset.
- Jointed contraptions are host-fixed compositions. Players can push their
  parts, operate authored motors, and directly pull one part through an
  exclusive host-side manipulation claim. The part never leaves the graph's
  authority.
- Maps may compose levers, sliders, ball sockets, ropes, springs, welded
  assemblies, conveyors, gravity areas, and machines such as trebuchets from a
  small Source-style physics vocabulary.
- Browser player transforms and Bun rigid-body transforms are gameplay truth.
  Gurgur is a cooperative trusted-client social world, not a competitive
  shooter or anti-cheat boundary.
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

Pickup is a reliable claim request against the prop's current authority version.
The first valid request wins; a held prop cannot be stolen. The browser moves a
centre-of-mass target toward a stable point in front of the player. Walls shorten
the target and turning rotates the captured relative orientation. Bun's control
joint supplies bounded physical response while the prop and every contact remain
in the shared solver. Once Bun confirms the claim, the holder sees an immediate
presentation-only loose-prop response while that view converges to Bun's result.
Other players, collisions, triggers, use actions, saves, and release velocity see
only Bun's body. Release removes only the control joint and visually converges
the holder's view without a gameplay handoff.

Direct contraption manipulation uses the same claim and target transport but a
different anchor: the browser selects the hit point instead of the centre of
mass. Bun pulls that point while continuing to simulate the complete machine.

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
