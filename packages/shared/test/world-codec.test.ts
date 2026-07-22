import { describe, expect, test } from "bun:test";
import { decodeWorldBundle, encodeWorldBundle, type WorldBundle } from "../src";

const bundle = (): WorldBundle => ({
  bundleVersion: 2,
  compilerVersion: 2,
  schemaVersion: 1,
  mapRevision: "a".repeat(64),
  sourceName: "fixture.map",
  entities: [
    {
      classname: "worldspawn",
      properties: { classname: "worldspawn", mapversion: "220" },
      runtimeProperties: { classname: "worldspawn", mapversion: 220 },
      brushIndices: [0],
    },
  ],
  brushes: [
    {
      entityIndex: 0,
      sourceBrushIndex: 0,
      sourceLine: 3,
      sourceColumn: 1,
      classname: "worldspawn",
      center: { x: 0, y: 0, z: 0 },
      worldVertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
      ],
      localVertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
      ],
      triangles: [[0, 2, 1]],
      triangleMaterials: ["STONE"],
      triangleSourceFaces: [4],
      triangleNormals: [{ x: 0, y: 1, z: 0 }],
      triangleUvs: [
        [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 0 },
        ],
      ],
    },
  ],
  staticCollision: {
    vertices: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ],
    triangles: [[0, 2, 1]],
    triangleSources: [{ entityIndex: 0, brushIndex: 0, faceIndex: 4 }],
  },
  renderBatches: [
    {
      material: "STONE",
      sensor: false,
      positions: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 1, y: 0, z: 0 },
      ],
      normals: [
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
      uvs: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 0 },
      ],
      indices: [0, 1, 2],
      triangleSources: [{ entityIndex: 0, brushIndex: 0, faceIndex: 4 }],
    },
  ],
});

describe("versioned binary world bundle", () => {
  test("round-trips deterministically with binary geometry sections", () => {
    const first = encodeWorldBundle(bundle());
    const second = encodeWorldBundle(bundle());
    expect(first).toEqual(second);
    expect(decodeWorldBundle(first)).toEqual(bundle());
  });

  test("rejects unsupported, truncated, and corrupt section tables", () => {
    const version = encodeWorldBundle(bundle());
    version[4] = 99;
    expect(() => decodeWorldBundle(version)).toThrow("unsupported");
    expect(() => decodeWorldBundle(new Uint8Array([1, 2, 3]))).toThrow("truncated");
    const bounds = encodeWorldBundle(bundle());
    new DataView(bounds.buffer).setUint32(12, 0xffff_ffff, true);
    expect(() => decodeWorldBundle(bounds)).toThrow("out of bounds");
  });
});
