import { createHash } from "node:crypto";
import {
  ENTITY_SCHEMA_VERSION,
  entityDefinitions,
  type EntityClassname,
  type PropertyDefinition,
} from "@gurgur/entity-schema";
import { parseValve220, type MapBrush, type ValveMap } from "@gurgur/map-format";
import {
  deriveWorldBuffers,
  encodeWorldBundle,
  type CompiledBrush,
  type CompiledEntity,
  type Vec2,
  type Vec3,
  type WorldBundle,
} from "@gurgur/shared";

export const METRES_PER_MAP_UNIT = 0.0254;
export const WORLD_COMPILER_VERSION = 2;
const EPSILON = 1e-5;

type Plane = { normal: Vec3; distance: number; sourceFace: number };
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (v: Vec3, amount: number): Vec3 => ({
  x: v.x * amount,
  y: v.y * amount,
  z: v.z * amount,
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const length = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const normalize = (v: Vec3): Vec3 => scale(v, 1 / length(v));

export function mapToWorld({ x, y, z }: Vec3): Vec3 {
  return {
    x: canonicalZero(x * METRES_PER_MAP_UNIT),
    y: canonicalZero(z * METRES_PER_MAP_UNIT),
    z: canonicalZero(-y * METRES_PER_MAP_UNIT),
  };
}

function canonicalZero(value: number): number {
  return value === 0 ? 0 : value;
}

function intersect(a: Plane, b: Plane, c: Plane): Vec3 | null {
  const bCrossC = cross(b.normal, c.normal);
  const determinant = dot(a.normal, bCrossC);
  if (Math.abs(determinant) < 1e-9) return null;
  return scale(
    add(
      add(scale(bCrossC, a.distance), scale(cross(c.normal, a.normal), b.distance)),
      scale(cross(a.normal, b.normal), c.distance),
    ),
    1 / determinant,
  );
}

function uniqueVertices(vertices: Vec3[]): Vec3[] {
  const unique: Vec3[] = [];
  for (const vertex of vertices) {
    if (!unique.some((other) => length(subtract(vertex, other)) < EPSILON)) unique.push(vertex);
  }
  return unique.toSorted((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
}

function compileBrush(
  brush: MapBrush,
  entityIndex: number,
  classname: string,
  authoredId: string | undefined,
  sourceBrushIndex: number,
): CompiledBrush {
  const facePoints = brush.faces.flatMap((face) => face.points);
  const authoredCenter = scale(facePoints.reduce(add, { x: 0, y: 0, z: 0 }), 1 / facePoints.length);
  const planes = brush.faces.map((face, sourceFace): Plane => {
    const [a, b, c] = face.points;
    const edgeCross = cross(subtract(b, a), subtract(c, a));
    if (length(edgeCross) < 1e-9)
      throw new Error(
        geometryDiagnostic(
          face.line,
          face.column,
          entityIndex,
          sourceBrushIndex,
          "degenerate plane",
          face.faceIndex,
        ),
      );
    let normal = normalize(edgeCross);
    let distance = dot(normal, a);
    if (dot(normal, authoredCenter) > distance) {
      normal = scale(normal, -1);
      distance *= -1;
    }
    return { normal, distance, sourceFace };
  });
  const candidates: Vec3[] = [];
  for (let a = 0; a < planes.length - 2; a += 1) {
    for (let b = a + 1; b < planes.length - 1; b += 1) {
      for (let c = b + 1; c < planes.length; c += 1) {
        const point = intersect(planes[a]!, planes[b]!, planes[c]!);
        if (
          point &&
          planes.every((plane) => dot(plane.normal, point) <= plane.distance + EPSILON)
        ) {
          candidates.push(point);
        }
      }
    }
  }
  const mapVertices = uniqueVertices(candidates);
  if (mapVertices.length < 4)
    throw new Error(
      geometryDiagnostic(
        brush.line,
        brush.column,
        entityIndex,
        sourceBrushIndex,
        "no finite convex volume",
      ),
    );
  const triangles: Array<[number, number, number]> = [];
  const triangleMaterials: string[] = [];
  const triangleSourceFaces: number[] = [];
  const triangleNormals: Vec3[] = [];
  const triangleUvs: Array<[Vec2, Vec2, Vec2]> = [];
  for (const plane of planes) {
    const indices = mapVertices
      .map((vertex, index) => ({ vertex, index }))
      .filter(({ vertex }) => Math.abs(dot(plane.normal, vertex) - plane.distance) < EPSILON);
    if (indices.length < 3)
      throw new Error(
        geometryDiagnostic(
          brush.line,
          brush.column,
          entityIndex,
          sourceBrushIndex,
          "invalid face",
          plane.sourceFace,
        ),
      );
    const center = scale(
      indices.reduce((sum, item) => add(sum, item.vertex), { x: 0, y: 0, z: 0 }),
      1 / indices.length,
    );
    const reference: Vec3 =
      Math.abs(plane.normal.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const u = normalize(cross(reference, plane.normal));
    const v = cross(plane.normal, u);
    indices.sort((left, right) => {
      const lp = subtract(left.vertex, center);
      const rp = subtract(right.vertex, center);
      return Math.atan2(dot(lp, v), dot(lp, u)) - Math.atan2(dot(rp, v), dot(rp, u));
    });
    for (let index = 1; index < indices.length - 1; index += 1) {
      const triangle: [number, number, number] = [
        indices[0]!.index,
        indices[index]!.index,
        indices[index + 1]!.index,
      ];
      triangles.push(triangle);
      const face = brush.faces[plane.sourceFace]!;
      triangleMaterials.push(face.material);
      triangleSourceFaces.push(face.faceIndex);
      triangleUvs.push(
        triangle.map((vertexIndex) => valveUv(mapVertices[vertexIndex]!, face)) as [
          Vec2,
          Vec2,
          Vec2,
        ],
      );
    }
  }
  const worldVertices = mapVertices.map(mapToWorld);
  for (const triangle of triangles) {
    const [a, b, c] = triangle.map((index) => worldVertices[index]!) as [Vec3, Vec3, Vec3];
    triangleNormals.push(normalize(cross(subtract(b, a), subtract(c, a))));
  }
  const center = scale(worldVertices.reduce(add, { x: 0, y: 0, z: 0 }), 1 / worldVertices.length);
  return {
    entityIndex,
    sourceBrushIndex,
    sourceLine: brush.line,
    sourceColumn: brush.column,
    classname,
    ...(authoredId ? { authoredId } : {}),
    center,
    worldVertices,
    localVertices: worldVertices.map((vertex) => subtract(vertex, center)),
    triangles,
    triangleMaterials,
    triangleSourceFaces,
    triangleNormals,
    triangleUvs,
  };
}

function valveUv(point: Vec3, face: MapBrush["faces"][number]): Vec2 {
  const uScale = face.scale[0];
  const vScale = face.scale[1];
  if (Math.abs(uScale) < 1e-12 || Math.abs(vScale) < 1e-12) {
    throw new Error(`face at line ${face.line}, column ${face.column} has zero texture scale`);
  }
  return {
    x:
      (point.x * face.uAxis[0] +
        point.y * face.uAxis[1] +
        point.z * face.uAxis[2] +
        face.uAxis[3]) /
      uScale,
    y:
      (point.x * face.vAxis[0] +
        point.y * face.vAxis[1] +
        point.z * face.vAxis[2] +
        face.vAxis[3]) /
      vScale,
  };
}

function validateValue(
  name: string,
  value: string,
  definition: PropertyDefinition,
  line: number,
): void {
  if (definition.type === "number" && !Number.isFinite(Number(value)))
    throw new Error(`line ${line}: ${name} must be numeric`);
  if (definition.type === "boolean" && value !== "0" && value !== "1")
    throw new Error(`line ${line}: ${name} must be 0 or 1`);
  if (definition.type === "vector") {
    const parts = value.trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || !parts.every(Number.isFinite))
      throw new Error(`line ${line}: ${name} must be a three-number vector`);
  }
}

function validateMap(map: ValveMap): void {
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const entity of map.entities)
    if (entity.properties.targetname) targets.add(entity.properties.targetname);
  for (const entity of map.entities) {
    const classname = entity.properties.classname as EntityClassname;
    const definition = entityDefinitions[classname];
    if (!definition)
      throw new Error(`${map.sourceName}:${entity.line}: unknown classname ${classname}`);
    if (definition.kind === "point" && entity.brushes.length !== 0)
      throw new Error(`line ${entity.line}: point entity has brushes`);
    if (definition.kind === "solid" && entity.brushes.length === 0)
      throw new Error(`line ${entity.line}: solid entity has no brushes`);
    const allowed = new Set(["classname", "origin", ...Object.keys(definition.properties)]);
    for (const [name, value] of Object.entries(entity.properties)) {
      if (!allowed.has(name))
        throw new Error(`line ${entity.line}: unknown ${classname} property ${name}`);
      const property = definition.properties[name as keyof typeof definition.properties] as
        | PropertyDefinition
        | undefined;
      if (property) validateValue(name, value, property, entity.line);
    }
    if (definition.persistent) {
      const id = entity.properties.authoredId;
      if (!id) throw new Error(`line ${entity.line}: ${classname} requires authoredId`);
      if (ids.has(id)) throw new Error(`line ${entity.line}: duplicate authoredId ${id}`);
      ids.add(id);
    }
    const target = entity.properties.target;
    if (target && !targets.has(target))
      throw new Error(`line ${entity.line}: unresolved target ${target}`);
  }
}

function geometryDiagnostic(
  line: number,
  column: number,
  entityIndex: number,
  brushIndex: number,
  message: string,
  faceIndex?: number,
): string {
  const face = faceIndex === undefined ? "" : `, face ${faceIndex}`;
  const location = `line ${line}, column ${column}, entity ${entityIndex}, brush ${brushIndex}`;
  return `${location}${face}: ${message}`;
}

function parseOrigin(value: string | undefined): Vec3 | undefined {
  if (!value) return undefined;
  const [x, y, z] = value.split(/\s+/).map(Number);
  if (![x, y, z].every(Number.isFinite)) throw new Error(`invalid entity origin ${value}`);
  return mapToWorld({ x: x!, y: y!, z: z! });
}

function compileRuntimeProperties(
  classname: EntityClassname,
  raw: Record<string, string>,
): CompiledEntity["runtimeProperties"] {
  const definition = entityDefinitions[classname];
  const compiled: CompiledEntity["runtimeProperties"] = { classname };
  for (const [name, property] of Object.entries(definition.properties)) {
    const source = raw[name] ?? property.default;
    if (source === undefined) continue;
    if (property.type === "boolean") {
      compiled[name] = source === true || source === 1 || source === "1";
      continue;
    }
    if (property.type === "number") {
      let value = Number(source);
      if (property.conversion === "map-distance" || property.conversion === "map-speed")
        value *= METRES_PER_MAP_UNIT;
      if (property.conversion === "yaw-degrees") value = (-value * Math.PI) / 180;
      compiled[name] = value;
      continue;
    }
    if (property.type === "vector") {
      const [x, y, z] = String(source).trim().split(/\s+/).map(Number) as [number, number, number];
      const value = { x, y, z };
      compiled[name] =
        property.conversion === "map-direction" ? normalize(mapToWorld(value)) : value;
      continue;
    }
    compiled[name] = String(source);
  }
  return compiled;
}

export function compileWorld(source: string, sourceName: string): WorldBundle {
  const map = parseValve220(source, sourceName);
  validateMap(map);
  const brushes: CompiledBrush[] = [];
  const entities: CompiledEntity[] = map.entities.map((entity, entityIndex) => {
    const classname = entity.properties.classname as EntityClassname;
    const brushIndices = entity.brushes.map((brush, sourceBrushIndex) => {
      const index = brushes.length;
      brushes.push(
        compileBrush(
          brush,
          entityIndex,
          entity.properties.classname!,
          entity.properties.authoredId,
          sourceBrushIndex,
        ),
      );
      return index;
    });
    const origin = parseOrigin(entity.properties.origin);
    return {
      classname: entity.properties.classname!,
      ...(entity.properties.authoredId ? { authoredId: entity.properties.authoredId } : {}),
      properties: entity.properties,
      runtimeProperties: compileRuntimeProperties(classname, entity.properties),
      brushIndices,
      ...(origin ? { origin } : {}),
    };
  });
  const derived = deriveWorldBuffers(brushes);
  const bundle: WorldBundle = {
    bundleVersion: 2,
    compilerVersion: WORLD_COMPILER_VERSION,
    schemaVersion: ENTITY_SCHEMA_VERSION,
    mapRevision: "0".repeat(64),
    sourceName,
    entities,
    brushes,
    ...derived,
  };
  bundle.mapRevision = createHash("sha256").update(encodeWorldBundle(bundle)).digest("hex");
  return bundle;
}
