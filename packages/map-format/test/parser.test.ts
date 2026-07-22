import { describe, expect, test } from "bun:test";
import { parseValve220 } from "../src";

describe("Valve 220 parser diagnostics", () => {
  test("supports escaped quoted properties and inline TrenchBroom comments", () => {
    const map = parseValve220(
      `
      { // entity
        "classname" "worldspawn"
        "mapversion" "220"
        "message" "say \\"hello\\" // literally" // trailing comment
        {
          ( -1 -1 -1 ) ( -1 -1 1 ) ( -1 1 1 ) M [ 0 -1 0 0 ] [ 0 0 -1 0 ] 0 1 1
          ( 1 1 1 ) ( 1 -1 1 ) ( 1 -1 -1 ) M [ 0 -1 0 0 ] [ 0 0 -1 0 ] 0 1 1
          ( -1 -1 -1 ) ( 1 -1 -1 ) ( 1 -1 1 ) M [ 1 0 0 0 ] [ 0 0 -1 0 ] 0 1 1
          ( 1 1 1 ) ( 1 1 -1 ) ( -1 1 -1 ) M [ 1 0 0 0 ] [ 0 0 -1 0 ] 0 1 1
          ( -1 -1 -1 ) ( -1 1 -1 ) ( 1 1 -1 ) M [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
          ( 1 1 1 ) ( -1 1 1 ) ( -1 -1 1 ) M [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
        }
      }
    `,
      "quoted.map",
    );
    expect(map.entities[0]?.properties.message).toBe('say "hello" // literally');
    expect(map.entities[0]?.column).toBe(7);
    expect(map.entities[0]?.brushes[0]?.faces[0]?.faceIndex).toBe(0);
  });

  test("reports file, line, column, entity, brush, and face", () => {
    expect(() =>
      parseValve220(
        `{
"classname" "worldspawn"
"mapversion" "220"
{
  nope
}
}`,
        "broken.map",
      ),
    ).toThrow(/broken\.map:5:3: face 0/);
  });

  test("fails deterministically under a seeded malformed-token corpus", () => {
    let state = 0x47555247;
    const next = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return (value ^ (value >>> 14)) >>> 0;
    };
    for (let caseIndex = 0; caseIndex < 512; caseIndex += 1) {
      const length = 1 + (next() % 256);
      const source = Array.from({ length }, () => String.fromCharCode(9 + (next() % 118))).join("");
      let first: string;
      let second: string;
      try {
        first = JSON.stringify(parseValve220(source, `fuzz-${caseIndex}.map`));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        first = String(error);
      }
      try {
        second = JSON.stringify(parseValve220(source, `fuzz-${caseIndex}.map`));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        second = String(error);
      }
      expect(second).toBe(first);
    }
  });
});
