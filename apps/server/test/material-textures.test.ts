import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadMaterialTextureAsset, loadMaterialTextureManifest } from "../src/material-textures";

describe("authored material texture assets", () => {
  test("changes the browser URL when authored PNG bytes change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gurgur-material-textures-"));
    const textureDirectory = join(directory, "GURGUR");
    const texturePath = join(textureDirectory, "CONCRETE.png");
    await mkdir(textureDirectory);
    try {
      await Bun.write(texturePath, new Uint8Array([137, 80, 78, 71, 1]));
      const first = await loadMaterialTextureManifest(pathToFileURL(`${directory}/`));
      await Bun.write(texturePath, new Uint8Array([137, 80, 78, 71, 2]));
      const second = await loadMaterialTextureManifest(pathToFileURL(`${directory}/`));
      expect(first.textures["GURGUR/CONCRETE"]).not.toBe(second.textures["GURGUR/CONCRETE"]);
      expect(first.etag).not.toBe(second.etag);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("resolves only safe authored PNG paths", async () => {
    const root = new URL("../../../content/textures/", import.meta.url);
    expect((await loadMaterialTextureAsset(root, "/textures/GURGUR/CONCRETE.png"))?.key).toBe(
      "GURGUR/CONCRETE",
    );
    expect(await loadMaterialTextureAsset(root, "/textures/GURGUR/%2e%2e/package.json")).toBeNull();
    expect(await loadMaterialTextureAsset(root, "/textures/GURGUR/CONCRETE.jpg")).toBeNull();
  });
});
