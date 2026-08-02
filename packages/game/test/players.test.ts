import { describe, expect, test } from "bun:test";
import { compileWorld, createGamePlayers, type GameEngine } from "../src";
import type { BodyState, Vec3 } from "@gurgur/engine";

const cube = `{
( 0 0 0 ) ( 0 0 16 ) ( 0 16 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 16 0 16 ) ( 16 0 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 0 0 0 ) ( 16 0 0 ) ( 16 0 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 16 16 0 ) ( 0 16 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 0 0 0 ) ( 0 16 0 ) ( 16 16 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 0 16 16 ) ( 0 0 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
}`;

describe("externally owned player proxies", () => {
  test("samples mapped source ticks at the host delay instead of packet arrival", () => {
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
      "player-proxy-timeline.map",
    );
    let tick = 0;
    let nextBody = 1;
    const proxyUpdates: Vec3[] = [];
    const proxyCreates: Vec3[] = [];
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
      createPlayerProxy(position) {
        proxyCreates.push({ ...position });
        return { index: nextBody++, generation: 1 };
      },
      updatePlayerProxy(_id, position) {
        proxyUpdates.push({ ...position });
      },
      destroyBody() {},
      driveBodyToTarget: () => false,
      requestSave() {},
    };
    const players = createGamePlayers({
      engine,
      bundle,
      restored: [],
      stepController: (state) => state,
      use: () => false,
    });
    const id = players.connect("browser", undefined, { externallyOwned: true });
    const initial = players.networkStates()[0]!;
    const publish = (sequence: number, sourceTick: number, x: number): void => {
      expect(
        players.applyOwnedState(id, {
          ...initial,
          stateSequence: sequence,
          sourceTick,
          position: { ...initial.position, x },
        }),
      ).toBe(true);
    };
    publish(1, 10, 0);
    publish(2, 12, 2);
    publish(3, 14, 4);

    tick = 19;
    players.step();
    expect(proxyUpdates.at(-1)?.x).toBeCloseTo(1, 5);
    tick = 21;
    players.step();
    expect(proxyUpdates.at(-1)?.x).toBeCloseTo(3, 5);

    expect(
      players.applyOwnedState(
        id,
        {
          ...initial,
          stateSequence: 4,
          sourceTick: 16,
          position: { ...initial.position, x: 100 },
        },
        true,
      ),
    ).toBe(true);
    expect(proxyCreates.at(-1)?.x).toBe(100);
  });
});
