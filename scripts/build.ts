import { mkdir, rm } from "node:fs/promises";

await import("../tools/compile-map/src/index");

await rm("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["apps/server/src/index.ts", "apps/web/index.html"],
  outdir: "dist",
  root: ".",
  target: "bun",
  minify: true,
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const workerResult = await Bun.build({
  entrypoints: ["apps/web/src/prediction-worker.ts"],
  outdir: "dist",
  root: ".",
  target: "browser",
  minify: true,
  sourcemap: "linked",
});
if (!workerResult.success) {
  for (const log of workerResult.logs) console.error(log);
  process.exit(1);
}

await mkdir("dist/apps/server/src", { recursive: true });
await mkdir("dist/content/generated", { recursive: true });
await Bun.write(
  "dist/apps/server/src/box3d.wasm",
  Bun.file("node_modules/box3d.js/dist/box3d.wasm"),
);
await Bun.write(
  "dist/content/generated/systems-garden.bin",
  Bun.file("content/generated/systems-garden.bin"),
);
console.log(`built ${result.outputs.length + workerResult.outputs.length} files plus box3d.wasm`);
