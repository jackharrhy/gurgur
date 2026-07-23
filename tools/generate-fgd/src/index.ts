import { entityDefinitions, type PropertyDefinition } from "@gurgur/entity-schema";

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
  faceattribs: { defaults: { scale: [0.5, 0.5] }, surfaceflags: [], contentflags: [] },
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
  if (!(await Bun.file(texturePath).exists())) {
    throw new Error(`missing authored material texture: ${texturePath}`);
  }
}
console.log(
  `generated TrenchBroom FGD/game config (${Object.keys(entityDefinitions).length} classes, ${materialNames.size} authored textures)`,
);
