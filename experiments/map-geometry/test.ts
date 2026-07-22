import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileSingleBrush, mapToWorld, METRES_PER_MAP_UNIT } from "./compiler";

const fixture = await Bun.file(`${import.meta.dir}/fixtures/cube.map`).text();
const first = compileSingleBrush(fixture);
const second = compileSingleBrush(fixture);

assert.equal(METRES_PER_MAP_UNIT, 0.0254);
assert.deepEqual(mapToWorld([1, 2, 3]), [0.0254, 0.07619999999999999, -0.0508]);
assert.equal(first.mapVertices.length, 8);
assert.equal(first.triangles.length, 12);
assert.equal(first.triangleSourceFaces.length, 12);
assert.deepEqual(second, first, "compiler output must be deterministic");

const expectedExtent = 64 * METRES_PER_MAP_UNIT;
for (const axis of [0, 1, 2] as const) {
  const values = first.worldVertices.map((vertex) => vertex[axis]);
  assert.ok(Math.abs(Math.min(...values) + expectedExtent) < 1e-9);
  assert.ok(Math.abs(Math.max(...values) - expectedExtent) < 1e-9);
}

assert.equal(72 * METRES_PER_MAP_UNIT, 1.8288, "72 map units is a six-foot player");

const serialized = JSON.stringify(first);
const hash = createHash("sha256").update(serialized).digest("hex");
assert.equal(hash, createHash("sha256").update(JSON.stringify(second)).digest("hex"));
console.log(`Valve 220 geometry and coordinate conversion: passed (${hash.slice(0, 12)})`);
