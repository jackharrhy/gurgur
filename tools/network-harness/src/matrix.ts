import { mkdir } from "node:fs/promises";
import { runRealNetworkHarness, type HarnessReport } from "./real-harness";
import { NETWORK_PROFILES } from "./profiles";

const seed = Number(process.env.HARNESS_SEED ?? 0x67757267);
const quick = process.env.HARNESS_QUICK === "1";
const runs: Array<{ name: string; options: Parameters<typeof runRealNetworkHarness>[0] }> = [
  ...[2, 8, 16, 32].map((clientCount) => ({
    name: `gate-${clientCount}`,
    options: {
      clientCount, durationMs: quick ? 700 : clientCount === 16 ? 5_000 : 1_500,
      seed: seed + clientCount, scenarioName: `gate-${clientCount}`,
    },
  })),
  {
    name: "five-second-outage",
    options: {
      clientCount: 16, durationMs: quick ? 2_000 : 8_000, seed: seed + 100,
      scenarioName: "five-second-outage",
      outage: { clientIds: [0], startMs: quick ? 300 : 1_500, endMs: quick ? 1_000 : 6_500 },
    },
  },
  {
    name: "receiver-stall",
    options: {
      clientCount: 16, durationMs: quick ? 1_200 : 3_000, seed: seed + 200,
      scenarioName: "receiver-stall", receiverPause: { clientIds: [1], untilMs: quick ? 500 : 1_500 },
    },
  },
  {
    name: "connected-reset",
    options: {
      clientCount: 16, durationMs: quick ? 1_200 : 3_000, seed: seed + 300,
      scenarioName: "connected-reset", resetAtMs: quick ? 400 : 1_000,
      profiles: [NETWORK_PROFILES.local, NETWORK_PROFILES.typical],
    },
  },
];

await mkdir("reports/network", { recursive: true });
const reports: HarnessReport[] = [];
for (const run of runs) {
  const report = await runRealNetworkHarness(run.options);
  reports.push(report);
  await Bun.write(`reports/network/${run.name}-${seed}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ scenario: run.name, clients: report.clientCount, aggregate: report.aggregate, recovery: report.scenario }));
}

const correctnessErrors = reports.reduce((sum, report) => sum + report.aggregate.correctnessErrors, 0);
const tickBudgetFailures = reports.filter((report) => report.scenario.name === "gate-16"
  && (report.server.tickP95Ms >= 8 || report.server.tickP99Ms >= 12));
const budgets = {
  local: { p95: 0.1, p99: 0.25, max: 0.5, age: 100, acknowledgement: 200, extrapolated: null },
  typical: { p95: 0.1, p99: 0.5, max: 1, age: 200, acknowledgement: 350, extrapolated: 1 },
  adverse: { p95: 1, p99: 1.25, max: 1.5, age: 450, acknowledgement: 1_100, extrapolated: null },
} as const;
const budgetFailures: string[] = [];
const epsilon = 1e-6;
for (const report of reports.filter((candidate) => candidate.scenario.name === "gate-16")) {
  for (const [profile, budget] of Object.entries(budgets)) {
    const metrics = report.profiles[profile];
    if (!metrics) continue;
    if (metrics.predictionErrorP95Metres > budget.p95 + epsilon) budgetFailures.push(`${report.scenario.name}/${profile} prediction p95`);
    if (metrics.predictionErrorP99Metres > budget.p99 + epsilon) budgetFailures.push(`${report.scenario.name}/${profile} prediction p99`);
    if (metrics.predictionErrorMaxMetres > budget.max + epsilon) budgetFailures.push(`${report.scenario.name}/${profile} prediction max`);
    if (metrics.snapshotAgeP95Ms > budget.age) budgetFailures.push(`${report.scenario.name}/${profile} snapshot age`);
    if (metrics.inputLatencyP95Ms > budget.acknowledgement) budgetFailures.push(`${report.scenario.name}/${profile} acknowledgement`);
    if (budget.extrapolated !== null && metrics.extrapolatedPercent > budget.extrapolated) {
      budgetFailures.push(`${report.scenario.name}/${profile} extrapolation`);
    }
  }
}
for (const report of reports.filter((candidate) => ["five-second-outage", "receiver-stall"].includes(candidate.scenario.name))) {
  if (report.scenario.recoveryPredictionSamples < 10) budgetFailures.push(`${report.scenario.name} recovery prediction samples`);
  if (report.scenario.recoverySnapshotSamples < 10) budgetFailures.push(`${report.scenario.name} recovery snapshot samples`);
  if (report.scenario.recoveryPredictionErrorP95Metres > 0.1) budgetFailures.push(`${report.scenario.name} recovery prediction`);
  if (report.scenario.recoverySnapshotAgeP95Ms > 200) budgetFailures.push(`${report.scenario.name} recovery snapshot age`);
}
if (correctnessErrors || tickBudgetFailures.length || budgetFailures.length) {
  throw new Error(`network matrix failed: ${correctnessErrors} correctness errors, ${tickBudgetFailures.length} tick-budget failures, budgets=${budgetFailures.join(",")}`);
}
