import { runRealNetworkHarness } from "./real-harness";

const quick = process.env.HARNESS_QUICK === "1";
const report = await runRealNetworkHarness({
  clientCount: quick ? 6 : 16,
  propCount: 128,
  durationMs: quick ? 1_500 : 5_000,
});
console.log(JSON.stringify(report));

const failures = [
  ...report.correctnessErrors,
  ...(report.profiles.typical!.stateAgeP95Ms >= 200 ? ["Typical state age"] : []),
  ...(report.profiles.adverse!.stateAgeP95Ms >= 300 ? ["Adverse state age"] : []),
  ...(report.profiles.typical!.presentationPathErrorP95Cm >= 2
    ? ["Typical presentation path error"]
    : []),
  ...(report.profiles.adverse!.presentationPathErrorP95Cm >= 5
    ? ["Adverse presentation path error"]
    : []),
  ...(report.profiles.typical!.bufferUnderrunPercent >= 0.1
    ? ["Typical presentation underrun"]
    : []),
  ...(report.profiles.adverse!.bufferUnderrunPercent >= 1 ? ["Adverse presentation underrun"] : []),
  ...(report.profiles.local!.advancingFramePercent < 95 ? ["Local banding"] : []),
  ...(report.profiles.typical!.advancingFramePercent < 95 ? ["Typical banding"] : []),
  ...(Object.values(report.profiles).some(
    (profile) =>
      profile.averageBitsPerSecondPerRecipient >= 2_000_000 || profile.staleAuthorityAccepted !== 0,
  )
    ? ["traffic or authority"]
    : []),
  ...(report.server.maxStateAgeMs <= 0 ? ["source state age unavailable"] : []),
  ...(report.server.tickP95Ms >= 8 ||
  report.server.tickP99Ms >= 12 ||
  report.server.discardedOverloadSeconds !== 0
    ? ["host tick budget"]
    : []),
];
if (failures.length > 0) throw new Error(`network matrix failed: ${failures.join(", ")}`);
