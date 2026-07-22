import { describe, expect, test } from "bun:test";
import { entityDefinitions, type EntityClassname } from "@gurgur/entity-schema";
import { compileWorld } from "@gurgur/world-compiler";
import { decodeWorldBundle, encodeWorldBundle } from "../../packages/shared/src";

type ParsedEntity = {
  properties: Record<string, string>;
  brushes: string[];
};

function parseFixture(source: string): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  let entity: ParsedEntity | null = null;
  let brush: string[] | null = null;
  let depth = 0;
  for (const [lineIndex, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line === "{") {
      if (depth === 0) entity = { properties: {}, brushes: [] };
      if (depth === 1) brush = [line];
      else if (depth >= 2) brush?.push(line);
      depth += 1;
      continue;
    }
    if (line === "}") {
      if (depth >= 2) brush?.push(line);
      depth -= 1;
      if (depth === 1 && brush && entity) {
        entity.brushes.push(brush.join("\n"));
        brush = null;
      }
      if (depth === 0 && entity) {
        entities.push(entity);
        entity = null;
      }
      if (depth < 0) throw new Error(`unexpected closing brace at line ${lineIndex + 1}`);
      continue;
    }
    if (depth === 1 && entity) {
      const property = line.match(/^"([^"]+)"\s+"([^"]*)"$/);
      if (!property) throw new Error(`invalid entity property at line ${lineIndex + 1}`);
      entity.properties[property[1]!] = property[2]!;
    } else if (depth >= 2 && brush) {
      brush.push(line);
    } else {
      throw new Error(`content outside entity at line ${lineIndex + 1}`);
    }
  }
  if (depth !== 0 || entity || brush) throw new Error("unclosed map structure");
  return entities;
}

const source = await Bun.file(new URL("./systems-garden.map", import.meta.url)).text();
const entities = parseFixture(source);
const compiledWorld = compileWorld(source, "systems-garden.map");

type Tuple3 = [number, number, number];
const subtract = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Tuple3, b: Tuple3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function facePoints(brush: string): Array<[Tuple3, Tuple3, Tuple3]> {
  return brush.split("\n").flatMap((line) => {
    const points = [...line.matchAll(/\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)/g)]
      .slice(0, 3)
      .map((match): Tuple3 => [Number(match[1]), Number(match[2]), Number(match[3])]);
    return points.length === 3 ? [[points[0]!, points[1]!, points[2]!]] : [];
  });
}

describe("Systems Garden map", () => {
  test("uses every entity class in the authored schema", () => {
    const used = new Set(entities.map((entity) => entity.properties.classname));
    for (const classname of Object.keys(entityDefinitions)) expect(used.has(classname)).toBe(true);
  });

  test("declares Valve 220 and uses TrenchBroom-compatible inward face winding", () => {
    expect(entities[0]?.properties.mapversion).toBe("220");
    for (const brush of entities.flatMap((entity) => entity.brushes)) {
      const faces = facePoints(brush);
      const allPoints = faces.flat();
      const center = allPoints.reduce<Tuple3>(
        (sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]],
        [0, 0, 0],
      ).map((value) => value / allPoints.length) as Tuple3;
      for (const [a, b, c] of faces) {
        const inwardNormal = cross(subtract(b, a), subtract(c, a));
        expect(dot(inwardNormal, subtract(center, a))).toBeGreaterThan(0);
      }
    }
  });

  test("gives every persistent entity a unique authoredId", () => {
    const ids = new Set<string>();
    for (const entity of entities) {
      const classname = entity.properties.classname as EntityClassname;
      const definition = entityDefinitions[classname];
      expect(definition).toBeDefined();
      if (!definition?.persistent) continue;
      const id = entity.properties.authoredId;
      expect(id).toBeTruthy();
      expect(ids.has(id!)).toBe(false);
      ids.add(id!);
    }
    expect(ids.size).toBe(13);
  });

  test("reconstructs every brush as finite convex geometry", () => {
    expect(compiledWorld.brushes.length).toBe(32);
    for (const compiled of compiledWorld.brushes) {
      expect(compiled.worldVertices.length).toBeGreaterThanOrEqual(4);
      expect(compiled.triangles.length).toBeGreaterThanOrEqual(4);
      expect(compiled.triangleSourceFaces).toHaveLength(compiled.triangles.length);
      expect(compiled.triangleNormals).toHaveLength(compiled.triangles.length);
      expect(compiled.triangleUvs).toHaveLength(compiled.triangles.length);
      for (const vertex of compiled.worldVertices) {
        expect(Object.values(vertex).every(Number.isFinite)).toBe(true);
      }
    }
  });

  test("emits a deterministic versioned binary artifact with compiled UV/source identity", () => {
    const again = compileWorld(source, "systems-garden.map");
    expect(encodeWorldBundle(again)).toEqual(encodeWorldBundle(compiledWorld));
    expect(decodeWorldBundle(encodeWorldBundle(compiledWorld))).toEqual(compiledWorld);
    expect(compiledWorld.mapRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(compiledWorld.compilerVersion).toBeGreaterThan(0);
    expect(compiledWorld.schemaVersion).toBeGreaterThan(0);
  });

  test("compiles map directions, dimensions, speeds, defaults, and rotations to runtime units", () => {
    const door = compiledWorld.entities.find((entity) => entity.classname === "func_door")!;
    expect(door.runtimeProperties.distance).toBeCloseTo(Number(door.properties.distance) * 0.0254);
    expect(door.runtimeProperties.speed).toBeCloseTo(Number(door.properties.speed) * 0.0254);
    expect(door.runtimeProperties.moveDirection).toEqual({ x: 0, y: 1, z: 0 });
    const spawn = compiledWorld.entities.find((entity) => entity.classname === "info_player_start")!;
    expect(typeof spawn.runtimeProperties.angle).toBe("number");
  });

  test("keeps decorative billboards render-only and converts their authored height", () => {
    const sprites = compiledWorld.entities.filter((entity) => entity.classname === "env_sprite");
    expect(sprites).toHaveLength(8);
    expect(sprites.every((sprite) => sprite.brushIndices.length === 0 && sprite.origin)).toBe(true);
    expect(sprites[0]!.runtimeProperties.scale).toBeCloseTo(112 * 0.0254);
  });

  test("keeps point entities out of brushes and solid entities inside them", () => {
    for (const entity of entities) {
      const definition = entityDefinitions[entity.properties.classname as EntityClassname];
      if (definition.kind === "point") expect(entity.brushes.length).toBe(0);
      else expect(entity.brushes.length).toBeGreaterThan(0);
    }
  });
});
