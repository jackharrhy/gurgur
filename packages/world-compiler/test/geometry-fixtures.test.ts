import { describe, expect, test } from "bun:test";
import { compileWorld } from "../src";

type Point = [number, number, number];
type Transform = (point: Point) => Point;

describe("Valve geometry conformance fixtures", () => {
  test.each([
    [
      "rotated",
      ([x, y, z]: Point): Point => {
        const angle = Math.PI / 6;
        return [
          x * Math.cos(angle) - y * Math.sin(angle),
          x * Math.sin(angle) + y * Math.cos(angle),
          z,
        ];
      },
    ],
    ["sloped", ([x, y, z]: Point): Point => [x, y, z + x * 0.5]],
    ["thin", ([x, y, z]: Point): Point => [x, y, z * 0.0001]],
    ["negative-coordinate", ([x, y, z]: Point): Point => [x - 512, y - 256, z - 128]],
  ] as Array<[string, Transform]>)(
    "compiles deterministic finite %s brushes",
    (_name, transform) => {
      const source = mapWithBrush(transform);
      const first = compileWorld(source, "fixture.map");
      const second = compileWorld(source, "fixture.map");
      expect(first).toEqual(second);
      expect(first.brushes[0]?.worldVertices).toHaveLength(8);
      expect(first.brushes[0]?.triangles).toHaveLength(12);
      expect(
        first.brushes[0]?.worldVertices.every((vertex) =>
          Object.values(vertex).every(Number.isFinite),
        ),
      ).toBe(true);
    },
  );

  test("rejects a degenerate face with complete source identity", () => {
    const source = mapWithBrush((point) => point).replace(
      "( -64 -64 -64 ) ( -64 -64 64 ) ( -64 64 64 )",
      "( 0 0 0 ) ( 1 1 1 ) ( 2 2 2 )",
    );
    expect(() => compileWorld(source, "invalid.map")).toThrow(
      /line 5, column 1, entity 0, brush 0, face 0: degenerate plane/,
    );
  });

  test("keeps every convex child of a multi-brush moving entity", () => {
    const source = `${mapWithBrush(([x, y, z]) => [x - 512, y - 512, z - 128])}
{
"classname" "func_physics"
"authoredId" "compound.fixture"
${brushText((point) => point)}
${brushText(([x, y, z]) => [x + 160, y, z])}
}`;
    const bundle = compileWorld(source, "compound.map");
    expect(bundle.entities[1]?.brushIndices).toEqual([1, 2]);
    expect(bundle.brushes).toHaveLength(3);
    expect(bundle.brushes.every((brush) => brush.localVertices.length === 8)).toBe(true);
  });
});

function mapWithBrush(transform: Transform): string {
  return `{
"classname" "worldspawn"
"mapversion" "220"
${brushText(transform)}
}`;
}

function brushText(transform: Transform): string {
  const p = (point: Point): string => {
    const [x, y, z] = transform(point);
    return `( ${x} ${y} ${z} )`;
  };
  const faces: Array<[Point, Point, Point]> = [
    [
      [-64, -64, -64],
      [-64, -64, 64],
      [-64, 64, 64],
    ],
    [
      [64, 64, 64],
      [64, -64, 64],
      [64, -64, -64],
    ],
    [
      [-64, -64, -64],
      [64, -64, -64],
      [64, -64, 64],
    ],
    [
      [64, 64, 64],
      [64, 64, -64],
      [-64, 64, -64],
    ],
    [
      [-64, -64, -64],
      [-64, 64, -64],
      [64, 64, -64],
    ],
    [
      [64, 64, 64],
      [-64, 64, 64],
      [-64, -64, 64],
    ],
  ];
  return `{
${faces.map(([a, b, c]) => `${p(a)} ${p(b)} ${p(c)} FIXTURE [ 1 0 0 8 ] [ 0 1 0 16 ] 0 0.25 0.5`).join("\n")}
}`;
}
