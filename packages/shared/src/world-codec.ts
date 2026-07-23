import type { Vec3 } from "./types";
import type {
  CompiledBrush,
  CompiledEntity,
  CompiledIndexedMesh,
  CompiledRenderBatch,
  Vec2,
  WorldBundle,
} from "./world";

const MAGIC = 0x44525747; // GWRD in little endian
const FORMAT_VERSION = 1;
const HEADER_BYTES = 8;
const SECTION_ENTRY_BYTES = 10;
const METADATA_SECTION = 1;
const ENTITIES_SECTION = 2;
const GEOMETRY_SECTION = 3;

type Section = { type: number; bytes: Uint8Array };
type BrushMetadata = Omit<
  CompiledBrush,
  | "worldVertices"
  | "localVertices"
  | "triangles"
  | "triangleSourceFaces"
  | "triangleNormals"
  | "triangleUvs"
>;

export function encodeWorldBundle(bundle: WorldBundle): Uint8Array {
  if (bundle.bundleVersion !== FORMAT_VERSION)
    throw new Error(`unsupported world bundle version ${bundle.bundleVersion}`);
  const encoder = new TextEncoder();
  const sections: Section[] = [
    {
      type: METADATA_SECTION,
      bytes: encoder.encode(
        JSON.stringify({
          mapRevision: bundle.mapRevision,
          sourceName: bundle.sourceName,
          brushes: bundle.brushes.map(
            ({
              worldVertices: _world,
              localVertices: _local,
              triangles: _triangles,
              triangleSourceFaces: _faces,
              triangleNormals: _normals,
              triangleUvs: _uvs,
              ...metadata
            }) => metadata,
          ),
        }),
      ),
    },
    { type: ENTITIES_SECTION, bytes: encoder.encode(JSON.stringify(bundle.entities)) },
    { type: GEOMETRY_SECTION, bytes: encodeGeometry(bundle.brushes) },
  ];
  const tableBytes = sections.length * SECTION_ENTRY_BYTES;
  const totalBytes =
    HEADER_BYTES +
    tableBytes +
    sections.reduce((sum, section) => sum + section.bytes.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, sections.length, true);
  let payloadOffset = HEADER_BYTES + tableBytes;
  sections.forEach((section, index) => {
    const entry = HEADER_BYTES + index * SECTION_ENTRY_BYTES;
    view.setUint16(entry, section.type, true);
    view.setUint32(entry + 2, payloadOffset, true);
    view.setUint32(entry + 6, section.bytes.byteLength, true);
    output.set(section.bytes, payloadOffset);
    payloadOffset += section.bytes.byteLength;
  });
  return output;
}

export function deriveWorldBuffers(brushes: CompiledBrush[]): {
  staticCollision: CompiledIndexedMesh;
  renderBatches: CompiledRenderBatch[];
} {
  const staticCollision: CompiledIndexedMesh = { vertices: [], triangles: [], triangleSources: [] };
  const batches = new Map<string, CompiledRenderBatch>();
  const moving = new Set(["func_physics", "func_door", "func_platform", "func_button"]);
  for (const brush of brushes) {
    if (brush.classname === "worldspawn") {
      const offset = staticCollision.vertices.length;
      staticCollision.vertices.push(...brush.worldVertices.map((vertex) => ({ ...vertex })));
      brush.triangles.forEach(([a, b, c], triangleIndex) => {
        staticCollision.triangles.push([a + offset, b + offset, c + offset]);
        staticCollision.triangleSources.push({
          entityIndex: brush.entityIndex,
          brushIndex: brush.sourceBrushIndex,
          faceIndex: brush.triangleSourceFaces[triangleIndex]!,
        });
      });
    }
    if (moving.has(brush.classname)) continue;
    brush.triangles.forEach((triangle, triangleIndex) => {
      const material = brush.triangleMaterials[triangleIndex]!;
      const sensor = brush.classname.startsWith("trigger_");
      const key = `${material}\0${Number(sensor)}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = {
          material,
          sensor,
          positions: [],
          normals: [],
          uvs: [],
          indices: [],
          triangleSources: [],
        };
        batches.set(key, batch);
      }
      const offset = batch.positions.length;
      for (let corner = 0; corner < 3; corner += 1) {
        batch.positions.push({ ...brush.worldVertices[triangle[corner]!]! });
        batch.normals.push({ ...brush.triangleNormals[triangleIndex]! });
        batch.uvs.push({ ...brush.triangleUvs[triangleIndex]![corner]! });
        batch.indices.push(offset + corner);
      }
      batch.triangleSources.push({
        entityIndex: brush.entityIndex,
        brushIndex: brush.sourceBrushIndex,
        faceIndex: brush.triangleSourceFaces[triangleIndex]!,
      });
    });
  }
  return {
    staticCollision,
    renderBatches: [...batches.values()].toSorted(
      (a, b) => a.material.localeCompare(b.material) || Number(a.sensor) - Number(b.sensor),
    ),
  };
}

export function decodeWorldBundle(input: ArrayBuffer | ArrayBufferView): WorldBundle {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < HEADER_BYTES) throw new Error("world bundle header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("world bundle magic mismatch");
  if (view.getUint16(4, true) !== FORMAT_VERSION)
    throw new Error("unsupported world bundle version");
  const sectionCount = view.getUint16(6, true);
  if (bytes.byteLength < HEADER_BYTES + sectionCount * SECTION_ENTRY_BYTES)
    throw new Error("world bundle section table is truncated");
  const sections = new Map<number, Uint8Array>();
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = HEADER_BYTES + index * SECTION_ENTRY_BYTES;
    const type = view.getUint16(entry, true);
    const offset = view.getUint32(entry + 2, true);
    const length = view.getUint32(entry + 6, true);
    if (sections.has(type)) throw new Error(`duplicate world bundle section ${type}`);
    if (
      offset < HEADER_BYTES + sectionCount * SECTION_ENTRY_BYTES ||
      offset + length > bytes.byteLength
    ) {
      throw new Error(`world bundle section ${type} is out of bounds`);
    }
    sections.set(type, bytes.slice(offset, offset + length));
  }
  const decoder = new TextDecoder();
  const metadataBytes = requiredSection(sections, METADATA_SECTION);
  const entityBytes = requiredSection(sections, ENTITIES_SECTION);
  const geometryBytes = requiredSection(sections, GEOMETRY_SECTION);
  const metadata = JSON.parse(decoder.decode(metadataBytes)) as {
    mapRevision: string;
    sourceName: string;
    brushes: BrushMetadata[];
  };
  if (!/^[0-9a-f]{64}$/.test(metadata.mapRevision))
    throw new Error("world bundle revision is invalid");
  const entities = JSON.parse(decoder.decode(entityBytes)) as CompiledEntity[];
  const brushes = decodeGeometry(geometryBytes, metadata.brushes);
  const derived = deriveWorldBuffers(brushes);
  return {
    bundleVersion: FORMAT_VERSION,
    mapRevision: metadata.mapRevision,
    sourceName: metadata.sourceName,
    entities,
    brushes,
    ...derived,
  };
}

function encodeGeometry(brushes: CompiledBrush[]): Uint8Array {
  const byteLength = brushes.reduce(
    (sum, brush) => sum + 4 + brush.worldVertices.length * 24 + 4 + brush.triangles.length * 88,
    0,
  );
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const brush of brushes) {
    assertParallelBrushData(brush);
    view.setUint32(offset, brush.worldVertices.length, true);
    offset += 4;
    for (const vertex of brush.worldVertices) offset = writeVec3(view, offset, vertex);
    view.setUint32(offset, brush.triangles.length, true);
    offset += 4;
    for (let index = 0; index < brush.triangles.length; index += 1) {
      const triangle = brush.triangles[index]!;
      view.setUint32(offset, triangle[0], true);
      view.setUint32(offset + 4, triangle[1], true);
      view.setUint32(offset + 8, triangle[2], true);
      view.setUint32(offset + 12, brush.triangleSourceFaces[index]!, true);
      offset = writeVec3(view, offset + 16, brush.triangleNormals[index]!);
      for (const uv of brush.triangleUvs[index]!) {
        view.setFloat64(offset, uv.x, true);
        view.setFloat64(offset + 8, uv.y, true);
        offset += 16;
      }
    }
  }
  return bytes;
}

function decodeGeometry(bytes: Uint8Array, metadata: BrushMetadata[]): CompiledBrush[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const brushes: CompiledBrush[] = [];
  for (const brush of metadata) {
    requireBytes(view, offset, 4);
    const vertexCount = view.getUint32(offset, true);
    offset += 4;
    const worldVertices: Vec3[] = [];
    for (let index = 0; index < vertexCount; index += 1) {
      requireBytes(view, offset, 24);
      worldVertices.push(readVec3(view, offset));
      offset += 24;
    }
    requireBytes(view, offset, 4);
    const triangleCount = view.getUint32(offset, true);
    offset += 4;
    const triangles: Array<[number, number, number]> = [];
    const triangleSourceFaces: number[] = [];
    const triangleNormals: Vec3[] = [];
    const triangleUvs: Array<[Vec2, Vec2, Vec2]> = [];
    for (let index = 0; index < triangleCount; index += 1) {
      requireBytes(view, offset, 88);
      const triangle: [number, number, number] = [
        view.getUint32(offset, true),
        view.getUint32(offset + 4, true),
        view.getUint32(offset + 8, true),
      ];
      if (triangle.some((vertex) => vertex >= vertexCount))
        throw new Error("world bundle triangle index is out of bounds");
      triangles.push(triangle);
      triangleSourceFaces.push(view.getUint32(offset + 12, true));
      triangleNormals.push(readVec3(view, offset + 16));
      offset += 40;
      const uvs: Vec2[] = [];
      for (let corner = 0; corner < 3; corner += 1) {
        uvs.push({ x: view.getFloat64(offset, true), y: view.getFloat64(offset + 8, true) });
        offset += 16;
      }
      triangleUvs.push(uvs as [Vec2, Vec2, Vec2]);
    }
    if (brush.triangleMaterials.length !== triangleCount)
      throw new Error("world bundle material count mismatch");
    brushes.push({
      ...brush,
      worldVertices,
      localVertices: worldVertices.map((vertex) => ({
        x: vertex.x - brush.center.x,
        y: vertex.y - brush.center.y,
        z: vertex.z - brush.center.z,
      })),
      triangles,
      triangleSourceFaces,
      triangleNormals,
      triangleUvs,
    });
  }
  if (offset !== view.byteLength) throw new Error("world bundle geometry has trailing bytes");
  return brushes;
}

function requiredSection(sections: Map<number, Uint8Array>, type: number): Uint8Array {
  const section = sections.get(type);
  if (!section) throw new Error(`world bundle section ${type} is missing`);
  return section;
}
function writeVec3(view: DataView, offset: number, value: Vec3): number {
  view.setFloat64(offset, value.x, true);
  view.setFloat64(offset + 8, value.y, true);
  view.setFloat64(offset + 16, value.z, true);
  return offset + 24;
}
function readVec3(view: DataView, offset: number): Vec3 {
  return {
    x: view.getFloat64(offset, true),
    y: view.getFloat64(offset + 8, true),
    z: view.getFloat64(offset + 16, true),
  };
}
function requireBytes(view: DataView, offset: number, count: number): void {
  if (offset + count > view.byteLength) throw new Error("world bundle geometry is truncated");
}
function assertParallelBrushData(brush: CompiledBrush): void {
  const count = brush.triangles.length;
  if (
    brush.triangleMaterials.length !== count ||
    brush.triangleSourceFaces.length !== count ||
    brush.triangleNormals.length !== count ||
    brush.triangleUvs.length !== count
  )
    throw new Error(
      `compiled brush ${brush.entityIndex}:${brush.sourceBrushIndex} has inconsistent triangle data`,
    );
}
