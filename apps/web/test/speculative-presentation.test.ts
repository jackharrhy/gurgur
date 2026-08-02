import { describe, expect, test } from "bun:test";
import type { BodySnapshot, Quat } from "@gurgur/engine";
import { SpeculativeHeldPresenter } from "../src/speculative-presentation";

const identity: Quat = { x: 0, y: 0, z: 0, w: 1 };
const body = (index = 1, x = 0): BodySnapshot => ({
  id: { index, generation: 1 },
  position: { x, y: 0, z: 0 },
  rotation: identity,
  linearVelocity: { x: 0, y: 0, z: 0 },
  angularVelocity: { x: 0, y: 0, z: 0 },
});

describe("speculative held-body presentation", () => {
  test("responds within one 60 Hz presentation interval without mutating authority input", () => {
    const presenter = new SpeculativeHeldPresenter();
    const authoritative = body();
    presenter.begin(authoritative.id, authoritative, 0);
    expect(
      presenter.target(authoritative.id, { position: { x: 1, y: 0, z: 0 }, rotation: identity }, 0),
    ).toBeTrue();

    expect(presenter.present(authoritative, 1_000 / 120).position.x).toBeCloseTo(0.5, 4);
    expect(presenter.present(authoritative, 1_000 / 60).position.x).toBeCloseTo(1, 4);
    expect(authoritative.position.x).toBe(0);
    expect(presenter.present(body(2, 7), 1_000 / 60).position.x).toBe(7);
    expect(presenter.diagnostics().maximumPositionErrorMetres).toBeCloseTo(1, 4);
  });

  test("reconciles release with a bounded correction and no first-frame jump", () => {
    const presenter = new SpeculativeHeldPresenter();
    const authoritative = body();
    const halfTurn: Quat = { x: 0, y: 1, z: 0, w: 0 };
    presenter.begin(authoritative.id, authoritative, 0);
    presenter.target(authoritative.id, { position: { x: 1, y: 0, z: 0 }, rotation: halfTurn }, 0);
    presenter.end(authoritative.id, 1_000 / 60);

    let previous = presenter.present(authoritative, 1_000 / 60);
    expect(previous.position.x).toBeCloseTo(1, 4);
    expect(quaternionDistance(previous.rotation, halfTurn)).toBeLessThan(1e-6);
    for (let frame = 2; frame <= 40; frame += 1) {
      const current = presenter.present(authoritative, frame * (1_000 / 60));
      expect(Math.abs(current.position.x - previous.position.x)).toBeLessThanOrEqual(2 / 60 + 1e-6);
      expect(quaternionDistance(current.rotation, previous.rotation)).toBeLessThanOrEqual(
        (Math.PI * 2) / 60 + 1e-6,
      );
      previous = current;
    }
    expect(previous.position.x).toBe(0);
    expect(quaternionDistance(previous.rotation, identity)).toBeLessThan(1e-6);
    expect(presenter.diagnostics()).toMatchObject({
      active: null,
      reconciling: null,
      positionErrorMetres: 0,
    });
  });

  test("clears active and released views on removal or epoch reset", () => {
    const presenter = new SpeculativeHeldPresenter();
    const authoritative = body();
    presenter.begin(authoritative.id, authoritative, 0);
    presenter.remove(authoritative.id);
    expect(presenter.diagnostics()).toMatchObject({ active: null, reconciling: null });
    presenter.begin(authoritative.id, authoritative, 1);
    presenter.end(authoritative.id, 2);
    presenter.reset();
    expect(presenter.diagnostics()).toMatchObject({
      active: null,
      reconciling: null,
      maximumPositionErrorMetres: 0,
    });
  });
});

function quaternionDistance(a: Quat, b: Quat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot)));
}
