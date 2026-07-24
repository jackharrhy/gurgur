import { describe, expect, test } from "bun:test";
import type { BodySnapshot } from "@gurgur/engine";
import { createPredictedPoseTimeline, mergeBodySamples } from "../src/presentation";

const pose = (x: number): BodySnapshot => ({
  id: { index: 1, generation: 1 },
  position: { x, y: 0.9, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
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
