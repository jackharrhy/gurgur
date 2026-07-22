import { mkdir } from "node:fs/promises";
import { runRealNetworkHarness } from "./real-harness";

const clientCount = Number(process.env.HARNESS_CLIENTS ?? 16);
const durationMs = Number(process.env.HARNESS_DURATION_MS ?? 5_000);
const seed = Number(process.env.HARNESS_SEED ?? 0x67757267);
const report = await runRealNetworkHarness({ clientCount, durationMs, seed });
await mkdir("reports/network", { recursive: true });
const path = `reports/network/network-${clientCount}-${seed}.json`;
await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ path, ...report.aggregate, server: report.server }));
if (report.aggregate.correctnessErrors) process.exitCode = 1;
