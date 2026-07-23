import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { entityDefinitions, type PropertyDefinition } from "@gurgur/entity-schema";
import { MATERIAL_TEXTURE_SIZE, createMaterialTextureRgba } from "@gurgur/shared";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const pngChunk = (type: string, data: Uint8Array): Buffer => {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of payload) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return chunk;
};

const encodePng = (rgba: Uint8ClampedArray): Buffer => {
  const size = MATERIAL_TEXTURE_SIZE;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    rows[rowStart] = 0;
    rows.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), rowStart + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array()),
  ]);
};

const fgdType = (property: PropertyDefinition): string =>
  ({
    string: "string",
    number: "float",
    boolean: "choices",
    vector: "vector",
    target: "target_destination",
    targetname: "target_source",
  })[property.type];

const quote = (value: string | number | boolean): string => ` : "${String(value)}"`;
const lines = ["// Generated from @gurgur/entity-schema. Do not edit by hand.", ""];
for (const [classname, definition] of Object.entries(entityDefinitions)) {
  const kind = definition.kind === "solid" ? "SolidClass" : "PointClass";
  const size =
    "size" in definition && definition.size
      ? ` size(${definition.size.slice(0, 3).join(" ")}, ${definition.size.slice(3).join(" ")})`
      : "";
  lines.push(
    `@${kind} color(${definition.color.join(" ")})${size} = ${classname} : "${definition.description}"`,
  );
  lines.push("[");
  lines.push('  classname(string) : "Entity class" : "' + classname + '"');
  for (const [name, property] of Object.entries(definition.properties)) {
    if (property.type === "boolean") {
      lines.push(
        `  ${name}(choices) : "${property.description}" : ${property.default ? 1 : 0} = [ 0 : "No" 1 : "Yes" ]`,
      );
    } else {
      const defaultValue = property.default === undefined ? "" : quote(property.default);
      lines.push(`  ${name}(${fgdType(property)}) : "${property.description}"${defaultValue}`);
    }
  }
  lines.push("]", "");
}

await Bun.write("content/trenchbroom/Gurgur.fgd", `${lines.join("\n")}\n`);
const gameConfig = {
  version: 9,
  name: "Gurgur",
  fileformats: [{ format: "Valve" }],
  filesystem: {
    searchpath: ".",
    packageformat: { extension: ".zip", format: "zip" },
  },
  materials: {
    root: "textures",
    format: { extensions: [".png", ".jpg", ".jpeg"], format: "image" },
  },
  entities: {
    definitions: ["Gurgur.fgd"],
    defaultcolor: "0.6 0.7 0.65 1.0",
  },
  tags: {
    brush: [
      { name: "Trigger", attribs: ["transparent"], match: "classname", pattern: "trigger_*" },
    ],
    brushface: [],
  },
  faceattribs: { defaults: { scale: [0.25, 0.25] }, surfaceflags: [], contentflags: [] },
  softMapBounds: "-4096 -4096 -4096 4096 4096 4096",
  compilationTools: [
    { name: "gurgur-compile-map", description: "Gurgur deterministic Valve 220 compiler" },
  ],
};
await Bun.write("content/trenchbroom/GameConfig.cfg", `${JSON.stringify(gameConfig, null, 2)}\n`);

const materialNames = new Set<string>();
const mapFiles = new Bun.Glob("content/maps/**/*.map");
for await (const path of mapFiles.scan({ dot: false })) {
  if (path.includes("/autosave/")) continue;
  const source = await Bun.file(path).text();
  for (const match of source.matchAll(/\)\s+([^\s]+)\s+\[/g)) materialNames.add(match[1]!);
}
for (const material of [...materialNames].toSorted()) {
  const texturePath = `content/textures/${material}.png`;
  await mkdir(dirname(texturePath), { recursive: true });
  await Bun.write(texturePath, encodePng(createMaterialTextureRgba(material)));
}
console.log(
  `generated TrenchBroom FGD/game config (${Object.keys(entityDefinitions).length} classes, ${materialNames.size} textures)`,
);
