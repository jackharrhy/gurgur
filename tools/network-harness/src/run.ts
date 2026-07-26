import { mkdir } from "node:fs/promises";
import { runRealNetworkHarness } from "./real-harness";

const quick = process.env.HARNESS_QUICK === "1";
const report = await runRealNetworkHarness({
  clientCount: Number(process.env.HARNESS_CLIENTS ?? (quick ? 6 : 16)),
  propCount: Number(process.env.HARNESS_PROPS ?? 128),
  durationMs: Number(process.env.HARNESS_DURATION_MS ?? (quick ? 1_500 : 5_000)),
});
await mkdir("reports/network", { recursive: true });
const path = `reports/network/protocol-v5-${report.clientCount}-${report.propCount}.json`;
await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ path, ...report }));

const blocking = process.env.HARNESS_NONBLOCKING !== "1";
const failures = blocking
  ? [
      ...report.correctnessErrors,
      ...(report.profiles.typical!.stateAgeP95Ms >= 200 ? ["Typical state age"] : []),
      ...(report.profiles.adverse!.stateAgeP95Ms >= 300 ? ["Adverse state age"] : []),
      ...(report.profiles.local!.advancingFramePercent < 95 ? ["Local banding"] : []),
      ...(report.profiles.typical!.advancingFramePercent < 95 ? ["Typical banding"] : []),
      ...Object.entries(report.profiles).flatMap(([name, profile]) =>
        profile.averageBitsPerSecondPerRecipient >= 2_000_000 ? [`${name} recipient traffic`] : [],
      ),
      ...(Object.values(report.profiles).some((profile) => profile.staleAuthorityAccepted !== 0)
        ? ["stale authority accepted"]
        : []),
      ...(report.server.tickP95Ms >= 8 ? ["host p95"] : []),
      ...(report.server.tickP99Ms >= 12 ? ["host p99"] : []),
    ]
  : [];
if (failures.length > 0) throw new Error(`network harness failed: ${failures.join(", ")}`);
