import type { RuntimeId, Vec3 } from "./types";

export type Vec2 = { x: number; y: number };
export type Rgb = { r: number; g: number; b: number };
export type SpriteAssetId = string;
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
  center: Vec3;
  worldVertices: Vec3[];
  localVertices: Vec3[];
  triangles: Array<[number, number, number]>;
  triangleMaterials: string[];
  triangleSourceFaces: number[];
  triangleNormals: Vec3[];
  triangleUvs: Array<[Vec2, Vec2, Vec2]>;
};

type BrushBody = { brushIndices: number[] };

export type DynamicBrushBody = BrushBody & {
  kind: "dynamic-brush";
  density: number;
  friction: number;
  restitution: number;
};

export type KinematicBrushBody = BrushBody & { kind: "kinematic-brush" };
export type StaticBrushBody = BrushBody & { kind: "static-brush" };
export type SensorBrushBody = BrushBody & { kind: "sensor-brush" };

export type BodySpec = DynamicBrushBody | KinematicBrushBody | StaticBrushBody | SensorBrushBody;

export type InteractionSpec = "none" | "use" | "grab";

export type PresentationSpec =
  | { kind: "brush"; transform: "world" | "body" }
  | { kind: "sprite"; asset: SpriteAssetId; height: number; glow: boolean }
  | { kind: "none" };

export type CompiledEntityCapabilities = {
  kind: string;
  authoredId?: string;
  origin?: Vec3;
  body: BodySpec | null;
  presentation: PresentationSpec;
  interaction: InteractionSpec;
};

export type WorldSettings = {
  title: string;
  gravity: Vec3;
  skyColor: Rgb;
};

export type PlayerSpawn = { name: string; position: Vec3; yaw: number };
export type ResetMarker = { label: string; position: Vec3 };

export type WorldBundle<TEntity extends CompiledEntityCapabilities = CompiledEntityCapabilities> = {
  bundleVersion: 1;
  mapRevision: string;
  sourceName: string;
  settings: WorldSettings;
  playerSpawns: PlayerSpawn[];
  resetMarkers: ResetMarker[];
  entities: TEntity[];
  brushes: CompiledBrush[];
  staticCollision: CompiledIndexedMesh;
  renderBatches: CompiledRenderBatch[];
};

export type RuntimeEntityRef =
  | { id: RuntimeId; kind: "world-entity"; entityIndex: number }
  | { id: RuntimeId; kind: "player" };

export type WorldMessage<TEntity extends CompiledEntityCapabilities = CompiledEntityCapabilities> =
  {
    type: "world";
    protocolVersion: 1;
    worldEpoch: number;
    bundle: WorldBundle<TEntity>;
    runtimeEntities: RuntimeEntityRef[];
  };

export type WorldManifestMessage = {
  type: "world";
  protocolVersion: 1;
  worldEpoch: number;
  mapRevision: string;
  bundleUrl: string;
  runtimeEntities: RuntimeEntityRef[];
};

export type LifecycleMessage = {
  type: "lifecycle";
  protocolVersion: 1;
  worldEpoch: number;
  created: RuntimeEntityRef[];
  removed: RuntimeId[];
};
