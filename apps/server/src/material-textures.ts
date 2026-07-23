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

export async function loadMaterialTextureManifest(
  rootUrl: URL,
): Promise<{ etag: string; textures: Record<string, string> }> {
  const root = fileURLToPath(rootUrl);
  const assets: Array<[string, string]> = [];
  for await (const path of new Bun.Glob("**/*.png").scan({ cwd: root, dot: false })) {
    const relativePath = path.replaceAll("\\", "/");
    const file = Bun.file(join(root, path));
    const hash = await hashFile(file);
    assets.push([
      relativePath.slice(0, -".png".length),
      `${encodedTexturePath(relativePath)}?v=${hash}`,
    ]);
  }
  assets.sort(([left], [right]) => left.localeCompare(right));
  const textures = Object.fromEntries(assets);
  const etag = `"${createHash("sha256").update(JSON.stringify(textures)).digest("hex")}"`;
  return { etag, textures };
}

export async function loadMaterialTextureAsset(
  rootUrl: URL,
  pathname: string,
): Promise<MaterialTextureAsset | null> {
  const prefix = "/textures/";
  if (!pathname.startsWith(prefix)) return null;
  const encodedSegments = pathname.slice(prefix.length).split("/");
  const segments: string[] = [];
  for (const encoded of encodedSegments) {
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
    key: relativePath.slice(0, -".png".length),
    url: encodedTexturePath(relativePath),
  };
}
