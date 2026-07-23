import { describe, expect, test } from "bun:test";
import { addMissingAuthoredIds, compileWorld } from "../src";

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
// newly duplicated in TrenchBroom
{
"classname" "func_physics"
${cube}
}
`;
    const repaired = addMissingAuthoredIds(source, "fixture.map", () => "physics.generated.01");
    expect(repaired.added).toEqual([
      { classname: "func_physics", authoredId: "physics.generated.01", line: 16 },
    ]);
    expect(repaired.source).toContain(
      '"classname" "func_physics"\n"authoredId" "physics.generated.01"',
    );
    expect(repaired.source.startsWith("// Game: Gurgur\n// Format: Valve\n")).toBe(true);
    expect(compileWorld(repaired.source, "fixture.map").entities[1]?.authoredId).toBe(
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
"classname" "func_physics"
"authoredId" "physics.existing"
${cube}
}`;
    expect(addMissingAuthoredIds(source, "fixture.map")).toEqual({ source, added: [] });
  });
});
