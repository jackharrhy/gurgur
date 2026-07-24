import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type MaterialTextureAsset = {
  file: Bun.BunFile;
  hash: string;
  key: string;
  url: string;
};

const hashFile = async (file: Bun.BunFile): Promise<string> =>
  createHash("sha256")
    .update(await file.bytes())
    .digest("hex");

const encodedTexturePath = (relativePath: string): string =>
  `/textures/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
const encodedSpritePath = (relativePath: string): string =>
  `/sprites/${relativePath.split("/").map(encodeURIComponent).join("/")}`;

export async function loadMaterialTextureManifest(
  rootUrl: URL,
): Promise<{ etag: string; textures: Record<string, string> }> {
  const textures = await loadLogicalPngManifest(rootUrl, encodedTexturePath);
  const etag = `"${createHash("sha256").update(JSON.stringify(textures)).digest("hex")}"`;
  return { etag, textures };
}

export async function loadAssetManifest(
  materialRoot: URL,
  spriteRoot: URL,
): Promise<{
  etag: string;
  materials: Record<string, string>;
  sprites: Record<string, string>;
}> {
  const materials = (await loadMaterialTextureManifest(materialRoot)).textures;
  const sprites = await loadLogicalPngManifest(spriteRoot, encodedSpritePath);
  const value = { materials, sprites };
  return {
    ...value,
    etag: `"${createHash("sha256").update(JSON.stringify(value)).digest("hex")}"`,
  };
}

export async function loadMaterialTextureAsset(
  rootUrl: URL,
  pathname: string,
): Promise<MaterialTextureAsset | null> {
  return loadPngAsset(rootUrl, pathname, "/textures/", encodedTexturePath);
}

export async function loadSpriteAsset(
  rootUrl: URL,
  pathname: string,
): Promise<MaterialTextureAsset | null> {
  return loadPngAsset(rootUrl, pathname, "/sprites/", encodedSpritePath);
}

async function loadLogicalPngManifest(
  rootUrl: URL,
  encodePath: (relativePath: string) => string,
): Promise<Record<string, string>> {
  const root = fileURLToPath(rootUrl);
  const assets: Array<[string, string]> = [];
  for await (const path of new Bun.Glob("**/*.png").scan({ cwd: root, dot: false })) {
    const relativePath = path.replaceAll("\\", "/");
    const file = Bun.file(join(root, path));
    const hash = await hashFile(file);
    assets.push([relativePath.slice(0, -4), `${encodePath(relativePath)}?v=${hash}`]);
  }
  return Object.fromEntries(assets.toSorted(([left], [right]) => left.localeCompare(right)));
}

async function loadPngAsset(
  rootUrl: URL,
  pathname: string,
  prefix: string,
  encodePath: (relativePath: string) => string,
): Promise<MaterialTextureAsset | null> {
  if (!pathname.startsWith(prefix)) return null;
  const segments: string[] = [];
  for (const encoded of pathname.slice(prefix.length).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (!segment || segment === "." || segment === ".." || /[/\\]/.test(segment)) return null;
    segments.push(segment);
  }
  const filename = segments.at(-1);
  if (!filename?.toLowerCase().endsWith(".png")) return null;
  const file = Bun.file(join(fileURLToPath(rootUrl), ...segments));
  if (!(await file.exists())) return null;
  const relativePath = segments.join("/");
  return {
    file,
    hash: await hashFile(file),
    key: relativePath.slice(0, -4),
    url: encodePath(relativePath),
  };
}
