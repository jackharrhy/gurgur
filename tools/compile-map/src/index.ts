import { rename, writeFile } from "node:fs/promises";
import { addMissingAuthoredIds, compileWorld } from "@gurgur/world-compiler";
import { encodeWorldBundle } from "@gurgur/shared";

const sourcePath = "content/maps/systems-garden.map";
const originalSource = await Bun.file(sourcePath).text();
const repaired = addMissingAuthoredIds(originalSource, sourcePath);
if (repaired.added.length > 0) {
  const temporaryPath = `${sourcePath}.gurgur.tmp`;
  await writeFile(temporaryPath, repaired.source);
  await rename(temporaryPath, sourcePath);
  for (const addition of repaired.added) {
    console.log(
      `assigned ${addition.authoredId} to ${addition.classname} from line ${addition.line}`,
    );
  }
}
const source = repaired.source;
const bundle = compileWorld(source, sourcePath);
const bytes = encodeWorldBundle(bundle);
await Bun.write("content/generated/systems-garden.bin", bytes);
await Bun.write("content/generated/systems-garden.json", `${JSON.stringify(bundle)}\n`);
console.log(
  `compiled ${bundle.brushes.length} brushes to ${bytes.byteLength} bytes (${bundle.mapRevision.slice(0, 12)})`,
);
