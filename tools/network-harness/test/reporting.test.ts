import { expect, test } from "bun:test";
import { summarizeHarnessReport, type HarnessSummarySource } from "../src/reporting";

test("keeps constrained saturation separate from gated movement quality", () => {
  const metrics = (predictionErrorMaxMetres: number) => ({
    predictionErrorP95Metres: predictionErrorMaxMetres,
    predictionErrorP99Metres: predictionErrorMaxMetres,
    predictionErrorMaxMetres,
    inputLatencyP95Ms: 0,
    snapshotAgeP95Ms: 0,
    extrapolatedPercent: 0,
    correctnessErrors: 0,
  });
  const report: HarnessSummarySource = {
    clientCount: 16,
    profiles: {
      local: metrics(0.1),
      typical: metrics(0.5),
      adverse: metrics(1.25),
      constrained: metrics(7.5),
    },
    scenario: {
      name: "gate-16",
      recoveryPredictionErrorP95Metres: 0,
      recoverySnapshotAgeP95Ms: 0,
      recoveryPredictionSamples: 0,
      recoverySnapshotSamples: 0,
    },
    server: {
      tickP95Ms: 1,
      tickP99Ms: 2,
      tickMaxMs: 3,
      discardedOverloadSeconds: 0,
      worldEpoch: 1,
      serverTick: 300,
      connectedClients: 16,
      backpressuredClients: 0,
      queuedBytes: 0,
      maxSnapshotAgeMs: 0,
    },
  };

  const summary = summarizeHarnessReport(report);
  expect(Object.keys(summary.qualityProfiles)).toEqual(["local", "typical", "adverse"]);
  expect(summary.saturationProfile?.predictionErrorMaxMetres).toBe(7.5);
  expect("aggregate" in summary).toBe(false);
});
