import { expect, test } from "bun:test";
import { MATERIAL_TEXTURE_SIZE, createMaterialTextureRgba } from "../src";

test("procedural material textures are deterministic and material-specific", () => {
  const concrete = createMaterialTextureRgba("GURGUR/CONCRETE");
  expect(concrete).toHaveLength(MATERIAL_TEXTURE_SIZE * MATERIAL_TEXTURE_SIZE * 4);
  expect(concrete).toEqual(createMaterialTextureRgba("GURGUR/CONCRETE"));
  expect(concrete).not.toEqual(createMaterialTextureRgba("GURGUR/CAUTION"));
});
