import assert from "node:assert/strict";
import createSeparateBox3D from "box3d.js";
import createInlineBox3D from "box3d.js/inline";
import { runPhysicsScenario } from "./scenario.js";

const separate = await runPhysicsScenario(createSeparateBox3D);
const inline = await runPhysicsScenario(createInlineBox3D);

assert.deepEqual(inline, separate, "inline and separate-Wasm builds must agree");
console.log("Bun physics runtime:", JSON.stringify(separate));
