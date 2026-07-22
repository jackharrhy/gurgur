export type Vec3 = [number, number, number];

type Plane = {
  normal: Vec3;
  distance: number;
  sourceFace: number;
};

export type CompiledBrush = {
  mapVertices: Vec3[];
  worldVertices: Vec3[];
  triangles: Array<[number, number, number]>;
  triangleSourceFaces: number[];
};

export const METRES_PER_MAP_UNIT = 0.0254;
const EPSILON = 1e-5;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (v: Vec3, amount: number): Vec3 => [v[0] * amount, v[1] * amount, v[2] * amount];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const normalize = (v: Vec3): Vec3 => scale(v, 1 / length(v));

export function mapToWorld([x, y, z]: Vec3): Vec3 {
  return [x * METRES_PER_MAP_UNIT, z * METRES_PER_MAP_UNIT, -y * METRES_PER_MAP_UNIT];
}

function intersect(a: Plane, b: Plane, c: Plane): Vec3 | null {
  const bCrossC = cross(b.normal, c.normal);
  const determinant = dot(a.normal, bCrossC);
  if (Math.abs(determinant) < 1e-9) return null;
  return scale(add(add(
    scale(bCrossC, a.distance),
    scale(cross(c.normal, a.normal), b.distance),
  ), scale(cross(a.normal, b.normal), c.distance)), 1 / determinant);
}

function uniqueVertices(vertices: Vec3[]) {
  const unique: Vec3[] = [];
  for (const vertex of vertices) {
    if (!unique.some((other) => length(subtract(vertex, other)) < EPSILON)) unique.push(vertex);
  }
  return unique;
}

function parseFacePoints(source: string) {
  const faces: Array<[Vec3, Vec3, Vec3]> = [];
  const linePattern = /^\s*\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)\s*\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)\s*\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)/;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match) continue;
    const values = match.slice(1).map(Number);
    if (!values.every(Number.isFinite)) throw new Error("non-finite face point");
    faces.push([
      [values[0], values[1], values[2]],
      [values[3], values[4], values[5]],
      [values[6], values[7], values[8]],
    ]);
  }
  if (faces.length < 4) throw new Error("brush must contain at least four planes");
  return faces;
}

export function compileSingleBrush(source: string): CompiledBrush {
  const facePoints = parseFacePoints(source);
  const centroid = scale(
    facePoints.flat().reduce((sum, point) => add(sum, point), [0, 0, 0] as Vec3),
    1 / (facePoints.length * 3),
  );
  const planes = facePoints.map(([a, b, c], sourceFace): Plane => {
    let normal = normalize(cross(subtract(b, a), subtract(c, a)));
    let distance = dot(normal, a);
    if (dot(normal, centroid) > distance) {
      normal = scale(normal, -1);
      distance *= -1;
    }
    return { normal, distance, sourceFace };
  });

  const candidates: Vec3[] = [];
  for (let a = 0; a < planes.length - 2; a += 1) {
    for (let b = a + 1; b < planes.length - 1; b += 1) {
      for (let c = b + 1; c < planes.length; c += 1) {
        const point = intersect(planes[a], planes[b], planes[c]);
        if (point && planes.every((plane) => dot(plane.normal, point) <= plane.distance + EPSILON)) {
          candidates.push(point);
        }
      }
    }
  }
  const mapVertices = uniqueVertices(candidates).sort((a, b) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  );
  if (mapVertices.length < 4) throw new Error("brush has no finite convex volume");

  const triangles: Array<[number, number, number]> = [];
  const triangleSourceFaces: number[] = [];
  for (const plane of planes) {
    const indices = mapVertices
      .map((vertex, index) => ({ vertex, index }))
      .filter(({ vertex }) => Math.abs(dot(plane.normal, vertex) - plane.distance) < EPSILON);
    if (indices.length < 3) throw new Error(`face ${plane.sourceFace} has fewer than three vertices`);

    const center = scale(indices.reduce((sum, item) => add(sum, item.vertex), [0, 0, 0] as Vec3), 1 / indices.length);
    const reference: Vec3 = Math.abs(plane.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize(cross(reference, plane.normal));
    const v = cross(plane.normal, u);
    indices.sort((left, right) => {
      const lp = subtract(left.vertex, center);
      const rp = subtract(right.vertex, center);
      return Math.atan2(dot(lp, v), dot(lp, u)) - Math.atan2(dot(rp, v), dot(rp, u));
    });

    for (let index = 1; index < indices.length - 1; index += 1) {
      triangles.push([indices[0].index, indices[index].index, indices[index + 1].index]);
      triangleSourceFaces.push(plane.sourceFace);
    }
  }

  return {
    mapVertices,
    worldVertices: mapVertices.map(mapToWorld),
    triangles,
    triangleSourceFaces,
  };
}
