import { describe, expect, test } from "bun:test";
import { PresentationBuffer } from "../src/presentation";
import { PROXY_INTERPOLATION_MS, type NetworkBodyState } from "@gurgur/engine";

const state = (sequence: number, x: number): NetworkBodyState => ({
  kind: "body",
  id: { index: 1, generation: 1 },
  authorityVersion: 1,
  stateSequence: sequence,
  sourceTick: sequence * 2,
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  linearVelocity: { x: 1, y: 0, z: 0 },
  angularVelocity: { x: 0, y: 0, z: 0 },
  flags: 0,
});

describe("source-tick proxy presentation", () => {
  test("keeps fixed proxies conservative while adaptive rendering starts at four ticks", () => {
    const proxy = new PresentationBuffer();
    const render = new PresentationBuffer({ networkDelayPolicy: "adaptive-render" });
    expect(proxy.diagnostics().networkDelayTicks).toBe(8);
    expect(render.diagnostics().networkDelayTicks).toBe(4);
  });

  test("raises adaptive render delay on measured lateness without stepping its timeline backwards", () => {
    const presentation = new PresentationBuffer({ networkDelayPolicy: "adaptive-render" });
    presentation.updateClock(20, 1_000, 0);
    presentation.pushNetwork([{ ...state(6, 6), sourceTick: 12, flags: 1 }], 1_000);
    presentation.pushNetwork([{ ...state(10, 10), sourceTick: 20, flags: 1 }], 1_000.1);
    const before = presentation.sample(1_000)[0]!.position.x;
    presentation.sample(1_050);
    const diagnostics = presentation.diagnostics();
    const after = presentation.sample(1_051)[0]!.position.x;
    expect(diagnostics.desiredNetworkDelayTicks).toBe(8);
    expect(diagnostics.networkDelayTicks).toBeGreaterThan(4);
    expect(diagnostics.networkDelayTicks).toBeLessThanOrEqual(8);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test("adapts each authority track without making one late actor delay every host body", () => {
    const presentation = new PresentationBuffer({ networkDelayPolicy: "adaptive-render" });
    presentation.pushNetwork(
      [
        { ...state(4, 4), id: { index: 1, generation: 1 }, sourceTick: 8, flags: 1 },
        { ...state(7, 7), id: { index: 2, generation: 1 }, sourceTick: 15, flags: 1 },
      ],
      900,
    );
    presentation.updateClock(20, 1_000, 0);
    presentation.pushNetwork(
      [
        { ...state(6, 6), id: { index: 1, generation: 1 }, sourceTick: 12, flags: 1 },
        { ...state(9, 9), id: { index: 2, generation: 1 }, sourceTick: 19, flags: 1 },
      ],
      1_000,
    );
    presentation.sample(1_010);
    expect(presentation.trackDelayTicks({ index: 1, generation: 1 })).toBeGreaterThan(4);
    expect(presentation.trackDelayTicks({ index: 2, generation: 1 })).toBe(4);
  });

  test("turns 30 Hz state into continuous 60 and 120 Hz motion", () => {
    for (const displayHz of [60, 120]) {
      const presentation = new PresentationBuffer();
      presentation.updateClock(0, 0, 0);
      for (let sequence = 0; sequence <= 12; sequence += 1) {
        const time = sequence * (1_000 / 30);
        presentation.pushNetwork([state(sequence, time / 1_000)], time);
      }
      const values: number[] = [];
      for (let time = PROXY_INTERPOLATION_MS; time <= 400; time += 1_000 / displayHz)
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

  test("retains the authoritative checkpoint target beneath a local prediction track", () => {
    const presentation = new PresentationBuffer({ networkDelayPolicy: "adaptive-render" });
    presentation.pushNetwork([state(1, 3)], 10);
    presentation.pushLocal([state(2, 9)], 20);
    expect(presentation.sample(20)[0]!.position.x).toBe(9);
    expect(presentation.latestNetwork(state(1, 0).id)?.position.x).toBe(3);
    presentation.remove(state(1, 0).id);
    expect(presentation.latestNetwork(state(1, 0).id)).toBeNull();
  });

  test("observes authoritative corrections without replacing an active local body track", () => {
    const presentation = new PresentationBuffer({ networkDelayPolicy: "adaptive-render" });
    presentation.pushNetwork([state(1, 3)], 10);
    presentation.pushLocal([state(2, 9)], 20);
    presentation.pushNetwork([state(3, 5)], 30, new Set(["1:1"]));
    expect(presentation.sample(30)[0]!.position.x).toBe(9);
    expect(presentation.latestNetwork(state(1, 0).id)?.position.x).toBe(5);
  });

  test("samples source cadence instead of compressing a late packet burst", () => {
    const presentation = new PresentationBuffer();
    presentation.updateClock(0, 0, 0);
    presentation.pushNetwork([state(0, 0)], 0);
    presentation.pushNetwork([state(1, 1)], 33);
    presentation.pushNetwork([state(2, 2)], 100);
    presentation.pushNetwork([state(3, 3)], 100.1);

    const immediatelyBeforeBurst = presentation.sample(PROXY_INTERPOLATION_MS + 49.9)[0]!.position
      .x;
    const immediatelyAfterBurst = presentation.sample(PROXY_INTERPOLATION_MS + 50.1)[0]!.position.x;

    expect(immediatelyBeforeBurst).toBeCloseTo(1.497, 2);
    expect(immediatelyAfterBurst).toBeCloseTo(1.503, 2);
    expect(immediatelyAfterBurst - immediatelyBeforeBurst).toBeLessThan(0.01);
  });
});
