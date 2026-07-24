import { describe, expect, test } from "bun:test";
import type { BodySnapshot } from "@gurgur/engine";
import * as THREE from "three/webgpu";
import { createPredictedPoseTimeline, mergeBodySamples } from "../src/presentation";
import { normalizeMaterialUv } from "../src/renderer";
import {
  createInteractionOutlineMaterial,
  createInteractionOutlineMaskMaterial,
  createRealityNodeMaterial,
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

test("reality materials bypass retro lighting, fog, and vertex treatment", () => {
  const texture = new THREE.Texture();
  const material = createRealityNodeMaterial(texture);
  expect(material.map).toBe(texture);
  expect(material.fog).toBeFalse();
  expect(material.toneMapped).toBeFalse();
  expect(material.vertexNode).toBeNull();
  expect(material.side).toBe(THREE.DoubleSide);
  material.dispose();
  texture.dispose();
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
