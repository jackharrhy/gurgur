import type { RuntimeId, Vec3 } from "./types";

export type Vec2 = { x: number; y: number };
export type TriangleSource = { entityIndex: number; brushIndex: number; faceIndex: number };

export type CompiledIndexedMesh = {
  vertices: Vec3[];
  triangles: Array<[number, number, number]>;
  triangleSources: TriangleSource[];
};

export type CompiledRenderBatch = {
  material: string;
  sensor: boolean;
  positions: Vec3[];
  normals: Vec3[];
  uvs: Vec2[];
  indices: number[];
  triangleSources: TriangleSource[];
};

export type CompiledBrush = {
  entityIndex: number;
  sourceBrushIndex: number;
  sourceLine: number;
  sourceColumn: number;
  classname: string;
  authoredId?: string;
  center: Vec3;
  worldVertices: Vec3[];
  localVertices: Vec3[];
  triangles: Array<[number, number, number]>;
  triangleMaterials: string[];
  triangleSourceFaces: number[];
  triangleNormals: Vec3[];
  triangleUvs: Array<[Vec2, Vec2, Vec2]>;
};

export type CompiledEntity = {
  classname: string;
  authoredId?: string;
  properties: Record<string, string>;
  runtimeProperties: Record<string, string | number | boolean | Vec3>;
  brushIndices: number[];
  origin?: Vec3;
};

export type WorldBundle = {
  bundleVersion: 2;
  compilerVersion: number;
  schemaVersion: number;
  mapRevision: string;
  sourceName: string;
  entities: CompiledEntity[];
  brushes: CompiledBrush[];
  staticCollision: CompiledIndexedMesh;
  renderBatches: CompiledRenderBatch[];
};

export type RuntimeEntity =
  | {
      id: RuntimeId;
      authoredId: string;
      classname: "func_physics" | "func_door" | "func_platform" | "func_button";
      brushIndex: number;
      brushIndices?: number[];
    }
  | {
      id: RuntimeId;
      authoredId: string;
      classname: "player";
    };

export type WorldMessage = {
  type: "world";
  protocolVersion: number;
  worldEpoch: number;
  bundle: WorldBundle;
  runtimeEntities: RuntimeEntity[];
};

export type WorldManifestMessage = {
  type: "world";
  protocolVersion: number;
  worldEpoch: number;
  mapRevision: string;
  bundleUrl: string;
  runtimeEntities: RuntimeEntity[];
};

export type LifecycleMessage = {
  type: "lifecycle";
  protocolVersion: number;
  worldEpoch: number;
  created: RuntimeEntity[];
  removed: RuntimeId[];
};
