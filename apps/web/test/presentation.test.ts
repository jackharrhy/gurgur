import { describe, expect, test } from "bun:test";
import { PresentationBuffer } from "../src/presentation";
import type { NetworkBodyState } from "@gurgur/engine";

const state = (sequence: number, x: number): NetworkBodyState => ({
  kind: "body",
  id: { index: 1, generation: 1 },
  authorityVersion: 1,
  stateSequence: sequence,
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  linearVelocity: { x: 1, y: 0, z: 0 },
  angularVelocity: { x: 0, y: 0, z: 0 },
  flags: 0,
});

describe("s&box-style proxy presentation", () => {
  test("turns 30 Hz state into continuous 60 and 120 Hz motion", () => {
    for (const displayHz of [60, 120]) {
      const presentation = new PresentationBuffer();
      for (let sequence = 0; sequence <= 12; sequence += 1) {
        const time = sequence * (1_000 / 30);
        presentation.pushNetwork([state(sequence, time / 1_000)], time);
      }
      const values: number[] = [];
      for (let time = 100; time <= 400; time += 1_000 / displayHz)
        values.push(presentation.sample(time)[0]!.position.x);
      const movingFrames = values
        .slice(1)
        .filter((value, index) => value > values[index]! + 1e-6).length;
      expect(movingFrames / (values.length - 1)).toBeGreaterThan(0.95);
    }
  });

  test("holds the newest sample rather than extrapolating and clears on authority change", () => {
    const presentation = new PresentationBuffer();
    presentation.pushNetwork([state(0, 0)], 0);
    presentation.pushNetwork([state(1, 1)], 33);
    expect(presentation.sample(10_000)[0]!.position.x).toBe(1);
    presentation.replaceReliable(state(0, 7), 100, false);
    expect(presentation.sample(100)[0]!.position.x).toBe(7);
  });
});
