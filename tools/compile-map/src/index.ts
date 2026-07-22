import { compileWorld } from "@gurgur/world-compiler";
import { encodeWorldBundle } from "@gurgur/shared";

const sourcePath = "content/maps/systems-garden.map";
const source = await Bun.file(sourcePath).text();
const bundle = compileWorld(source, sourcePath);
const bytes = encodeWorldBundle(bundle);
await Bun.write("content/generated/systems-garden.bin", bytes);
await Bun.write("content/generated/systems-garden.json", `${JSON.stringify(bundle)}\n`);
console.log(`compiled ${bundle.brushes.length} brushes to ${bytes.byteLength} bytes (${bundle.mapRevision.slice(0, 12)})`);
