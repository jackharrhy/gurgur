import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type BodyState, type InputCommand } from "@gurgur/engine";
import { compileWorld, createGamePlayers, type GameEngine } from "../src";

const cube = `{
( 0 0 0 ) ( 0 0 16 ) ( 0 16 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 16 0 16 ) ( 16 0 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 0 0 0 ) ( 16 0 0 ) ( 16 0 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 16 16 0 ) ( 0 16 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 0 0 0 ) ( 0 16 0 ) ( 16 16 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 0 16 16 ) ( 0 0 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
}`;

describe("server-owned player command queue", () => {
  test("deduplicates redundant bundles, processes one command per tick, and executes edges once", () => {
    const bundle = compileWorld(
      `{
"classname" "worldspawn"
"mapversion" "220"
${cube}
}
{
"classname" "info_player_start"
"origin" "0 0 64"
}`,
      "server-player-commands.map",
    );
    let tick = 0;
    let nextBody = 1;
    const processed: Array<{ moveX: number; jumpCounter: number }> = [];
    const engine: GameEngine = {
      get tick() {
        return tick;
      },
      dt: 1 / 60,
      bodies: {
        forEntity: () => null,
        resolve: () => null,
        state: (id): BodyState => ({
          id,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          linearVelocity: { x: 0, y: 0, z: 0 },
          angularVelocity: { x: 0, y: 0, z: 0 },
          awake: true,
        }),
      },
      setKinematicTarget() {},
      setBodyAwake() {},
      raycast: () => null,
      createPlayerProxy: () => ({ index: nextBody++, generation: 1 }),
      updatePlayerProxy() {},
      destroyBody() {},
      driveBodyToTarget: () => false,
      requestSave() {},
    };
    const players = createGamePlayers({
      engine,
      bundle,
      restored: [],
      stepController: (state, input) => {
        processed.push({ moveX: input.moveX, jumpCounter: input.jumpCounter });
        return { ...state, lastJumpCounter: input.jumpCounter };
      },
      use: () => false,
    });
    const id = players.connect("server-player");
    for (const sequence of [0, 1, 2, 3])
      expect(players.acceptInput(id, command(sequence), 1)).toBe(true);
    for (const sequence of [0, 1, 2, 3])
      expect(players.acceptInput(id, command(sequence), 1)).toBe(true);

    for (tick = 0; tick < 4; tick += 1) players.step();
    expect(processed).toEqual([
      { moveX: 0, jumpCounter: 1 },
      { moveX: 0.25, jumpCounter: 1 },
      { moveX: 0.5, jumpCounter: 1 },
      { moveX: 0.75, jumpCounter: 1 },
    ]);
    expect(players.prediction(id)?.lastProcessedInputSequence).toBe(3);

    tick += 1;
    players.step();
    expect(processed.at(-1)).toEqual({ moveX: 0.75, jumpCounter: 1 });
    expect(players.networkStates()[0]!.lastJumpCounter).toBe(1);
  });
});

function command(sequence: number): InputCommand {
  return {
    type: "input",
    protocolVersion: PROTOCOL_VERSION,
    worldEpoch: 1,
    sequence,
    clientTick: sequence,
    moveX: sequence / 4,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    jumpCounter: 1,
    interactCounter: 0,
    interactTarget: null,
    primaryCounter: 0,
  };
}
