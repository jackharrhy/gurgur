import { describe, expect, test } from "bun:test";
import type { BodyState, RuntimeId } from "@gurgur/engine";
import { compileWorld, createGameSimulation, type GameEngine } from "../src";

const cube = `{
( 0 0 0 ) ( 0 0 16 ) ( 0 16 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 16 0 16 ) ( 16 0 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 0 0 0 ) ( 16 0 0 ) ( 16 0 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 16 16 0 ) ( 0 16 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 0 0 0 ) ( 0 16 0 ) ( 16 16 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 0 16 16 ) ( 0 0 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
}`;

describe("typed trigger outputs", () => {
  test("dispatches gameplay inputs by entity index on player enter and exit", () => {
    const bundle = compileWorld(
      `{
"classname" "worldspawn"
"mapversion" "220"
${cube}
}
{
"classname" "info_player_start"
"origin" "0 0 64"
}
{
"classname" "func_door"
"authoredId" "door.zone"
"targetname" "zone_door"
${cube}
}
{
"classname" "trigger_multiple"
"authoredId" "trigger.zone"
"onEnterTarget" "zone_door"
"onEnterInput" "open"
"onExitTarget" "zone_door"
"onExitInput" "close"
${cube}
}`,
      "trigger-simulation.map",
    );
    const door = runtimeId(0);
    const trigger = runtimeId(1);
    const playerProxy = runtimeId(2);
    let tick = 10;
    const bodyStates = new Map([
      [key(door), bodyState(door)],
      [key(trigger), bodyState(trigger)],
      [key(playerProxy), bodyState(playerProxy)],
    ]);
    const engine: GameEngine = {
      get tick() {
        return tick;
      },
      dt: 1 / 60,
      bodies: {
        forEntity(entityIndex) {
          return entityIndex < 2 ? { id: runtimeId(entityIndex), entityIndex } : null;
        },
        resolve(id) {
          return id.index < 2 ? { id, entityIndex: id.index } : null;
        },
        state(id) {
          return bodyStates.get(key(id))!;
        },
      },
      setKinematicTarget(id, position) {
        bodyStates.get(key(id))!.position = { ...position };
      },
      setBodyAwake() {},
      raycast() {
        return null;
      },
      createPlayerProxy() {
        return playerProxy;
      },
      updatePlayerProxy() {},
      destroyBody() {},
      driveBodyToTarget() {
        return false;
      },
      requestSave() {},
    };
    const simulation = createGameSimulation({
      engine,
      bundle,
      restored: null,
      players: {
        restored: [],
        stepController: (state) => state,
      },
    });
    simulation.players.connect("fixture-player");

    simulation.processSensorEvents([{ sensor: trigger, visitor: playerProxy }], []);
    expect(mechanismDirection(simulation.persistedState().entities)).toBe(1);

    tick += 1;
    simulation.step();
    simulation.processSensorEvents([], [{ sensor: trigger, visitor: playerProxy }]);
    expect(mechanismDirection(simulation.persistedState().entities)).toBe(-1);
  });
});

function mechanismDirection(
  entities: ReturnType<ReturnType<typeof createGameSimulation>["persistedState"]>["entities"],
): -1 | 0 | 1 {
  const mechanism = entities.find((entity) => entity.kind === "linear-mover");
  if (!mechanism || mechanism.kind !== "linear-mover") throw new Error("mechanism is missing");
  return mechanism.direction;
}

function runtimeId(index: number): RuntimeId {
  return { index, generation: 1 };
}

function key(id: RuntimeId): string {
  return `${id.index}:${id.generation}`;
}

function bodyState(id: RuntimeId): BodyState {
  return {
    id,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    awake: true,
  };
}
