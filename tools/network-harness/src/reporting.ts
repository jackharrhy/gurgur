import type { HarnessReport } from "./real-harness";

const QUALITY_PROFILE_NAMES = ["local", "typical", "adverse"] as const;

export type HarnessSummarySource = Pick<
  HarnessReport,
  "clientCount" | "profiles" | "scenario" | "server"
>;

export function summarizeHarnessReport(report: HarnessSummarySource) {
  return {
    scenario: report.scenario.name,
    clients: report.clientCount,
    qualityProfiles: Object.fromEntries(
      QUALITY_PROFILE_NAMES.flatMap((name) => {
        const metrics = report.profiles[name];
        return metrics ? [[name, metrics]] : [];
      }),
    ),
    saturationProfile: report.profiles.constrained ?? null,
    recovery: report.scenario,
    server: report.server,
  };
}
