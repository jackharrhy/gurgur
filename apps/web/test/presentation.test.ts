import { describe, expect, test } from "bun:test";
import type { BodySnapshot } from "@gurgur/engine";
import * as THREE from "three/webgpu";
import { createPredictedPoseTimeline, mergeBodySamples } from "../src/presentation";
import {
  createBillboardGeometry,
  normalizeMaterialUv,
  renderableBrushTriangleIndices,
} from "../src/renderer";
import {
  createInteractionOutlineMaterial,
  createInteractionOutlineMaskMaterial,
  createRealityNodeMaterial,
  createSpriteNodeMaterial,
  createWorldNodeMaterial,
  INTERACTION_OUTLINE_MASK_RENDER_ORDER,
  INTERACTION_OUTLINE_RENDER_ORDER,
  INTERACTION_OUTLINE_SCALE,
  PLAYER_RENDER_ORDER,
} from "../src/retro-rendering";

const pose = (x: number): BodySnapshot => ({
  id: { index: 1, generation: 1 },
  position: { x, y: 0.9, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
});

test("material UVs normalize against each authored PNG's real dimensions", () => {
  expect(normalizeMaterialUv({ x: 724, y: -543 }, { width: 1448, height: 1086 })).toEqual([
    0.5, 0.5,
  ]);
});

test("moving brush presentation omits collision-only faces", () => {
  expect(
    renderableBrushTriangleIndices({
      triangles: [
        [0, 1, 2],
        [0, 2, 3],
        [4, 5, 6],
      ],
      triangleSourceFaces: [0, 0, 1],
      collisionOnlyFaceIndices: [0],
    }),
  ).toEqual([2]);
});

test("reality materials use native scene lighting while bypassing fog and vertex treatment", () => {
  const texture = new THREE.Texture();
  const material = createRealityNodeMaterial(texture);
  expect(material).toBeInstanceOf(THREE.MeshLambertNodeMaterial);
  expect(material.lights).toBeTrue();
  expect(material.map).toBe(texture);
  expect(material.fog).toBeFalse();
  expect(material.toneMapped).toBeFalse();
  expect(material.vertexNode).toBeNull();
  material.dispose();
  texture.dispose();
});

test("retro and reality brush materials cull backfaces", () => {
  const texture = new THREE.Texture();
  const retro = createWorldNodeMaterial(texture, "FIXTURE", false);
  const reality = createRealityNodeMaterial(texture);
  expect(retro.side).toBe(THREE.FrontSide);
  expect(reality.side).toBe(THREE.FrontSide);
  retro.dispose();
  reality.dispose();
  texture.dispose();
});

test("retro world geometry and textures use the ordinary perspective projection", () => {
  const texture = new THREE.Texture();
  for (const name of ["FIXTURE", "WATER"]) {
    const material = createWorldNodeMaterial(texture, name, false);
    const nodeKinds = new Set<string>();
    material.colorNode?.traverse((node) => nodeKinds.add(node.constructor.name));
    expect(material.vertexNode).toBeNull();
    expect(nodeKinds.has("VaryingNode")).toBeFalse();
    material.dispose();
  }
  texture.dispose();
});

test("ordinary world and billboard materials participate in native scene lighting", () => {
  const texture = new THREE.Texture();
  const world = createWorldNodeMaterial(texture, "FIXTURE", false);
  const sprite = createSpriteNodeMaterial(texture, false);
  const glow = createSpriteNodeMaterial(texture, true);
  expect(world).toBeInstanceOf(THREE.MeshLambertNodeMaterial);
  expect(sprite).toBeInstanceOf(THREE.MeshLambertNodeMaterial);
  expect(glow).toBeInstanceOf(THREE.MeshBasicNodeMaterial);
  expect(world.lights).toBeTrue();
  expect(sprite.lights).toBeTrue();
  expect(glow).not.toBeInstanceOf(THREE.MeshLambertNodeMaterial);
  world.dispose();
  sprite.dispose();
  glow.dispose();
  texture.dispose();
});

test("billboard geometry preserves the authored origin inside a lit plane", () => {
  const geometry = createBillboardGeometry(2, 4, { x: 0.5, y: 0.25 });
  geometry.computeBoundingBox();
  expect(geometry.boundingBox?.min.y).toBeCloseTo(-1);
  expect(geometry.boundingBox?.max.y).toBeCloseTo(3);
  geometry.dispose();
});

describe("predicted display-rate presentation", () => {
  test("fills 120 Hz render frames between 60 Hz fixed poses", () => {
    const buffer = createPredictedPoseTimeline();
    buffer.push(pose(0), 0);
    buffer.push(pose(0.1), 1000 / 60);

    expect(buffer.sample(1000 / 60)?.position.x).toBeCloseTo(0);
    expect(buffer.sample(1000 / 60 + 1000 / 120)?.position.x).toBeCloseTo(0.05);
    expect(buffer.sample(1000 / 60 + 1000 / 60)?.position.x).toBeCloseTo(0.1);
  });

  test("does not smear teleports across a frame", () => {
    const buffer = createPredictedPoseTimeline();
    buffer.push(pose(0), 0);
    buffer.push(pose(2), 1000 / 60);
    expect(buffer.sample(1000 / 60)?.position.x).toBe(2);
  });

  test("lets a current authoritative contact proxy override its buffered sample", () => {
    const authoritative = pose(0);
    const contactProxy = pose(0.25);
    expect(mergeBodySamples([authoritative], [contactProxy])).toEqual([contactProxy]);
  });
});

describe("interaction outline presentation", () => {
  test("stencils the exact silhouette before drawing the wider hull and players", () => {
    const mask = createInteractionOutlineMaskMaterial();
    const outline = createInteractionOutlineMaterial(false);
    expect(INTERACTION_OUTLINE_SCALE).toBe(1.08);
    expect(mask.colorWrite).toBeFalse();
    expect(mask.depthTest).toBeFalse();
    expect(mask.stencilWrite).toBeTrue();
    expect(mask.transparent).toBeFalse();
    expect(mask.stencilFuncMask).toBe(0xff);
    expect(mask.stencilWriteMask).toBe(0xff);
    expect(mask.side).toBe(THREE.FrontSide);
    expect(mask.stencilRef).toBe(0);
    expect(mask.stencilFunc).toBe(THREE.AlwaysStencilFunc);
    expect(mask.stencilZPass).toBe(THREE.IncrementStencilOp);
    expect(outline.depthTest).toBeFalse();
    expect(outline.depthWrite).toBeFalse();
    expect(outline.transparent).toBeTrue();
    expect(outline.stencilWrite).toBeTrue();
    expect(outline.stencilWriteMask).toBe(0);
    expect(outline.stencilFuncMask).toBe(0xff);
    expect(outline.stencilRef).toBe(0);
    expect(outline.stencilFunc).toBe(THREE.EqualStencilFunc);
    expect(INTERACTION_OUTLINE_MASK_RENDER_ORDER).toBeLessThan(INTERACTION_OUTLINE_RENDER_ORDER);
    expect(INTERACTION_OUTLINE_RENDER_ORDER).toBeLessThan(PLAYER_RENDER_ORDER);
    mask.dispose();
    outline.dispose();
  });
});
