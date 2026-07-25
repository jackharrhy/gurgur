import { describe, expect, test } from "bun:test";
import {
  addMissingAuthoredIds,
  compileWorld,
  entityDefinitions,
  logicalAudioAssetProperty,
  logicalSpriteAssetProperty,
} from "../src";

const cube = `{
( 0 0 0 ) ( 0 0 16 ) ( 0 16 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 16 0 16 ) ( 16 0 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 0 0 0 ) ( 16 0 0 ) ( 16 0 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 16 16 0 ) ( 0 16 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 0 0 0 ) ( 0 16 0 ) ( 16 16 0 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
( 16 16 16 ) ( 0 16 16 ) ( 0 0 16 ) TEST [ 1 0 0 0 ] [ 0 1 0 0 ] 0 1 1
}`;

describe("authored ID repair", () => {
  test("inserts missing persistent IDs after classname and produces compilable source", () => {
    const source = `// Game: Gurgur
// Format: Valve
{
"classname" "worldspawn"
"mapversion" "220"
${cube}
}
{
"classname" "info_player_start"
"origin" "0 0 64"
}
// newly duplicated in TrenchBroom
{
"classname" "func_physics"
${cube}
}
`;
    const repaired = addMissingAuthoredIds(source, "fixture.map", () => "physics.generated.01");
    expect(repaired.added).toEqual([
      { classname: "func_physics", authoredId: "physics.generated.01", line: 20 },
    ]);
    expect(repaired.source).toContain(
      '"classname" "func_physics"\n"authoredId" "physics.generated.01"',
    );
    expect(repaired.source.startsWith("// Game: Gurgur\n// Format: Valve\n")).toBe(true);
    expect(compileWorld(repaired.source, "fixture.map").entities[0]?.authoredId).toBe(
      "physics.generated.01",
    );
  });

  test("leaves already identified maps byte-for-byte unchanged", () => {
    const source = `{
"classname" "worldspawn"
"mapversion" "220"
${cube}
}
{
"classname" "info_player_start"
"origin" "0 0 64"
}
{
"classname" "func_physics"
"authoredId" "physics.existing"
${cube}
}`;
    expect(addMissingAuthoredIds(source, "fixture.map")).toEqual({ source, added: [] });
  });
});

describe("typed entity catalog", () => {
  test("owns the complete current mapper classname catalog in one place", () => {
    expect(Object.keys(entityDefinitions).toSorted()).toEqual(
      [
        "env_sprite",
        "ambient_audio",
        "func_button",
        "func_door",
        "func_physics",
        "func_platform",
        "info_player_start",
        "info_world_reset",
        "light_ambient",
        "light_directional",
        "light_point",
        "light_spot",
        "logic_relay",
        "trigger_multiple",
        "trigger_once",
        "worldspawn",
      ].toSorted(),
    );
    expect(entityDefinitions.func_physics.editor.persistent).toBe(true);
    expect("authoredId" in entityDefinitions.func_physics.properties).toBe(false);
  });

  test("validates extensionless logical sprite IDs at the authoring boundary", () => {
    const property = logicalSpriteAssetProperty("sprite");
    const source = {
      sourceName: "fixture.map",
      classname: "env_sprite",
      property: "sprite",
      line: 4,
    };
    expect(property.parse("decor/fern", source)).toBe("decor/fern");
    expect(() => property.parse("../fern.png", source)).toThrow("extensionless logical asset ID");
  });

  test("validates extensionless logical audio IDs at the authoring boundary", () => {
    const property = logicalAudioAssetProperty("audio");
    const source = {
      sourceName: "fixture.map",
      classname: "ambient_audio",
      property: "audio",
      line: 4,
    };
    expect(property.parse("music/dylan", source)).toBe("music/dylan");
    expect(() => property.parse("../dylan.mp3", source)).toThrow("extensionless logical asset ID");
  });

  test("partitions authored settings, spawns, reset markers, and sprites", () => {
    const bundle = compileWorld(
      baseMap(`
{
"classname" "info_player_start"
"name" "balcony"
"origin" "10 20 30"
"angle" "90"
}
{
"classname" "info_world_reset"
"origin" "20 30 40"
"label" "Garden reset"
}
{
"classname" "env_sprite"
"origin" "40 50 60"
"sprite" "terminal"
"scale" "32"
"glow" "1"
}`),
      "partition.map",
    );
    expect(bundle.settings).toEqual({
      title: "Typed fixture",
      gravity: { x: 0, y: -4.5, z: 0 },
      skyColor: { r: 0.2, g: 0.3, b: 0.4 },
    });
    expect(bundle.playerSpawns).toEqual([
      { name: "default", position: { x: 0, y: 1.6256, z: 0 }, yaw: 0 },
      {
        name: "balcony",
        position: { x: 0.254, y: 0.762, z: -0.508 },
        yaw: -Math.PI / 2,
      },
    ]);
    expect(bundle.resetMarkers).toEqual([
      { label: "Garden reset", position: { x: 0.508, y: 1.016, z: -0.762 } },
    ]);
    expect(bundle.entities).toEqual([
      {
        kind: "sprite",
        origin: { x: 1.016, y: 1.524, z: -1.27 },
        body: null,
        presentation: {
          kind: "sprite",
          asset: "terminal",
          height: 0.8128,
          glow: true,
        },
        interaction: "none",
      },
    ]);
  });

  test("compiles mapper light aliases into one typed presentation capability", () => {
    const bundle = compileWorld(
      baseMap(`
{
"classname" "light_ambient"
"origin" "0 0 64"
"color" "0.2 0.3 0.4"
"intensity" "0.6"
"volumeDensity" "0.35"
}
{
"classname" "light_directional"
"origin" "0 0 128"
"direction" "0 0 -1"
"shadowDistance" "512"
}
{
"classname" "light_point"
"origin" "64 32 96"
"range" "256"
"volumetric" "0"
}
{
"classname" "light_spot"
"origin" "128 0 192"
"direction" "1 0 -1"
"range" "640"
"angle" "30"
"penumbra" "0.25"
}`),
      "lights.map",
    );
    expect(bundle.entities.map((entity) => entity.kind)).toEqual([
      "light",
      "light",
      "light",
      "light",
    ]);
    expect(bundle.entities.map((entity) => entity.presentation.kind)).toEqual([
      "light",
      "light",
      "light",
      "light",
    ]);
    const [ambient, directional, point, spot] = bundle.entities;
    expect(ambient).toMatchObject({
      origin: { x: 0, y: 1.6256, z: 0 },
      presentation: {
        mode: "ambient",
        color: { r: 0.2, g: 0.3, b: 0.4 },
        intensity: 0.6,
        volumeDensity: 0.35,
      },
    });
    expect(directional).toMatchObject({
      presentation: {
        mode: "directional",
        direction: { x: 0, y: -1, z: 0 },
        castShadow: true,
        shadowDistance: 13.0048,
      },
    });
    expect(point).toMatchObject({
      presentation: {
        mode: "point",
        range: 6.5024,
        decay: 2,
        castShadow: true,
        volumetric: false,
      },
    });
    expect(point?.origin?.x).toBeCloseTo(1.6256);
    expect(point?.origin?.y).toBeCloseTo(2.4384);
    expect(point?.origin?.z).toBeCloseTo(-0.8128);
    expect(spot).toMatchObject({
      presentation: {
        mode: "spot",
        range: 16.256,
        angle: Math.PI / 6,
        penumbra: 0.25,
        volumetric: true,
      },
    });
  });

  test("enforces authored identity, required links, and spawn invariants", () => {
    expect(() =>
      compileWorld(
        baseMap(
          "",
          `{
"classname" "info_player_start"
"name" "other"
"origin" "0 0 64"
}`,
        ),
        "spawn.map",
      ),
    ).toThrow("spawn named default");
    expect(() =>
      compileWorld(
        baseMap(`
{
"classname" "logic_relay"
"authoredId" "relay.missing"
"targetname" "source"
}`),
        "required.map",
      ),
    ).toThrow("logic_relay.target is required");
    expect(() =>
      compileWorld(
        baseMap(`
{
"classname" "logic_relay"
"authoredId" "relay.unresolved"
"targetname" "source"
"target" "missing"
}`),
        "target.map",
      ),
    ).toThrow("unresolved target missing");
    expect(() =>
      compileWorld(
        baseMap(`
{
"classname" "func_physics"
${cube}
}`),
        "identity.map",
      ),
    ).toThrow("requires authoredId");
  });

  test("allows several typed recipients to share one resolved target name", () => {
    const bundle = compileWorld(
      baseMap(`
{
"classname" "func_door"
"authoredId" "door.shared"
"targetname" "shared"
${cube}
}
{
"classname" "func_platform"
"authoredId" "platform.shared"
"targetname" "shared"
${cube}
}
{
"classname" "trigger_multiple"
"authoredId" "trigger.shared"
"onEnterTarget" "shared"
"onEnterInput" "open"
${cube}
}`),
      "targets.map",
    );
    expect(bundle.entities.map((entity) => entity.kind)).toEqual([
      "linear-mover",
      "linear-mover",
      "trigger",
    ]);
    expect(bundle.entities[2]).toMatchObject({
      outputs: {
        enter: { targetEntityIndices: [0, 1], input: "open" },
      },
    });
  });

  test("compiles typed trigger enter and exit outputs to ambient entity indices", () => {
    const bundle = compileWorld(
      baseMap(`
{
"classname" "ambient_audio"
"targetname" "garden_song"
"audio" "dylan"
"volume" "0.8"
"fadeIn" "0.25"
"fadeOut" "0.5"
"loop" "1"
"priority" "4"
}
{
"classname" "trigger_multiple"
"authoredId" "trigger.audio.garden"
"onEnterTarget" "garden_song"
"onEnterInput" "play"
"onExitTarget" "garden_song"
"onExitInput" "stop"
${cube}
}`),
      "audio.map",
    );
    expect(bundle.entities).toEqual([
      {
        kind: "ambient-audio",
        asset: "dylan",
        volume: 0.8,
        fadeInSeconds: 0.25,
        fadeOutSeconds: 0.5,
        loop: true,
        priority: 4,
        body: null,
        presentation: { kind: "none" },
        interaction: "none",
      },
      {
        kind: "trigger",
        authoredId: "trigger.audio.garden",
        mode: "multiple",
        outputs: {
          enter: { targetEntityIndices: [0], input: "play" },
          exit: { targetEntityIndices: [0], input: "stop" },
        },
        waitSeconds: 0.5,
        body: { kind: "sensor-brush", brushIndices: [1] },
        presentation: { kind: "none" },
        interaction: "none",
      },
    ]);
  });

  test("rejects unsupported receiver inputs and incomplete listener pairs", () => {
    expect(() =>
      compileWorld(
        baseMap(`
{
"classname" "ambient_audio"
"targetname" "garden_song"
"audio" "dylan"
}
{
"classname" "trigger_multiple"
"authoredId" "trigger.audio.invalid-input"
"onEnterTarget" "garden_song"
"onEnterInput" "open"
${cube}
}`),
        "invalid-input.map",
      ),
    ).toThrow("ambient-audio target garden_song does not support input open");

    expect(() =>
      compileWorld(
        baseMap(`
{
"classname" "ambient_audio"
"targetname" "garden_song"
"audio" "dylan"
}
{
"classname" "trigger_multiple"
"authoredId" "trigger.audio.missing-exit"
"onEnterTarget" "garden_song"
"onEnterInput" "play"
${cube}
}`),
        "missing-exit.map",
      ),
    ).toThrow("listener outputs must pair play on enter with stop on exit");
  });
});

function baseMap(
  extra: string,
  spawn = `{
"classname" "info_player_start"
"origin" "0 0 64"
}`,
): string {
  return `{
"classname" "worldspawn"
"mapversion" "220"
"message" "Typed fixture"
"gravity" "4.5"
"skyColor" "0.2 0.3 0.4"
${cube}
}
${spawn}
${extra}`;
}
