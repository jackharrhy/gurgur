import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { loadAssetManifest } from "../apps/server/src/material-textures";

await import("../tools/generate-fgd/src/index");
await import("../tools/compile-map/src/index");

const materialTextureRoot = new URL("../content/textures/", import.meta.url);
const spriteRoot = new URL("../content/sprites/", import.meta.url);
const assetManifest = await loadAssetManifest(materialTextureRoot, spriteRoot);
const compiledWorld = (await Bun.file("content/generated/systems-garden.json").json()) as {
  brushes: Array<{ triangleMaterials: string[] }>;
  entities: Array<{ presentation: { kind: string; asset?: string } }>;
};
const requiredMaterials = new Set(
  compiledWorld.brushes.flatMap((brush) => brush.triangleMaterials),
);
for (const material of requiredMaterials) {
  if (!assetManifest.materials[material]) {
    throw new Error(`missing authored material texture: content/textures/${material}.png`);
  }
}
for (const entity of compiledWorld.entities) {
  if (entity.presentation.kind === "sprite" && !assetManifest.sprites[entity.presentation.asset!])
    throw new Error(`missing authored sprite: content/sprites/${entity.presentation.asset}.png`);
}

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
await mkdir("dist/content/generated/player-billboard", { recursive: true });
let materialTextureCount = 0;
for await (const path of new Bun.Glob("**/*.png").scan({
  cwd: "content/textures",
  dot: false,
})) {
  const destination = `dist/content/textures/${path}`;
  await mkdir(dirname(destination), { recursive: true });
  await Bun.write(destination, Bun.file(`content/textures/${path}`));
  materialTextureCount += 1;
}
let spriteCount = 0;
for await (const path of new Bun.Glob("**/*.png").scan({
  cwd: "content/sprites",
  dot: false,
})) {
  const destination = `dist/content/sprites/${path}`;
  await mkdir(dirname(destination), { recursive: true });
  await Bun.write(destination, Bun.file(`content/sprites/${path}`));
  spriteCount += 1;
}
await Bun.write(
  "dist/apps/server/src/box3d.wasm",
  Bun.file("node_modules/box3d.js/dist/box3d.wasm"),
);
await Bun.write(
  "dist/content/generated/systems-garden.bin",
  Bun.file("content/generated/systems-garden.bin"),
);
await Bun.write(
  "dist/content/generated/player-billboard/player-billboard.png",
  Bun.file("content/generated/player-billboard/player-billboard.png"),
);
console.log(
  `built ${result.outputs.length + workerResult.outputs.length} files, box3d.wasm, ${materialTextureCount} authored textures, and ${spriteCount} sprites`,
);
