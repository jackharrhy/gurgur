import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadAssetManifest,
  loadMaterialTextureAsset,
  loadMaterialTextureManifest,
  loadSpriteAsset,
  materialRenderMode,
} from "../src/material-textures";

describe("authored material texture assets", () => {
  test("changes the browser URL when authored PNG bytes change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-material-textures-"));
    const textureDirectory = join(directory, "GURGUR");
    const texturePath = join(textureDirectory, "CONCRETE.png");
    await mkdir(textureDirectory);
    try {
      await Bun.write(texturePath, pngHeader(1448, 1086, 1));
      const first = await loadMaterialTextureManifest(pathToFileURL(`${directory}/`));
      await Bun.write(texturePath, pngHeader(1448, 1086, 2));
      const second = await loadMaterialTextureManifest(pathToFileURL(`${directory}/`));
      expect(first.textures["GURGUR/CONCRETE"]).not.toBe(second.textures["GURGUR/CONCRETE"]);
      expect(first.textures["GURGUR/CONCRETE"]).toMatchObject({
        width: 1448,
        height: 1086,
        renderMode: "retro",
      });
      expect(first.etag).not.toBe(second.etag);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("classifies temporary Dylan and authored REAL materials as reality breaks", () => {
    expect(materialRenderMode("GURGUR/dylans1")).toBe("reality");
    expect(materialRenderMode("GURGUR/REAL/family-photo")).toBe("reality");
    expect(materialRenderMode("GURGUR/CONCRETE")).toBe("retro");
  });

  test("resolves only safe authored PNG paths", async () => {
    const textureRoot = new URL("../../../content/textures/", import.meta.url);
    const spriteRoot = new URL("../../../content/sprites/", import.meta.url);
    const manifest = await loadAssetManifest(textureRoot, spriteRoot);
    expect(manifest.materials["GURGUR/CONCRETE"]?.url).toContain("/textures/");
    expect(manifest.sprites.fern).toContain("/sprites/");
    expect(
      (await loadMaterialTextureAsset(textureRoot, "/textures/GURGUR/CONCRETE.png"))?.key,
    ).toBe("GURGUR/CONCRETE");
    expect((await loadSpriteAsset(spriteRoot, "/sprites/fern.png"))?.key).toBe("fern");
    expect(
      await loadMaterialTextureAsset(textureRoot, "/textures/GURGUR/%2e%2e/package.json"),
    ).toBeNull();
    expect(await loadMaterialTextureAsset(textureRoot, "/textures/GURGUR/CONCRETE.jpg")).toBeNull();
    expect(await loadSpriteAsset(spriteRoot, "/sprites/%2e%2e/fern.png")).toBeNull();
  });
});

function pngHeader(width: number, height: number, marker: number): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = marker;
  return bytes;
}
