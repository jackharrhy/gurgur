import { runPhysicsScenario } from "/scenario.js";

try {
  const separateModule = await import("/vendor/box3d.mjs");
  const inlineModule = await import("/vendor/box3d.inline.mjs");
  const separate = await runPhysicsScenario(separateModule.default);
  const inline = await runPhysicsScenario(inlineModule.default);

  if (JSON.stringify(separate) !== JSON.stringify(inline)) {
    throw new Error("Browser Box3D variants produced different states");
  }

  postMessage({ ok: true, result: separate });
} catch (error) {
  postMessage({ ok: false, error: String(error?.stack ?? error) });
}
