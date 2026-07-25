export function nextPredictionTargetTick(estimatedServerTick: number): number {
  const target = Math.floor(estimatedServerTick) + 1;
  if (
    !Number.isFinite(estimatedServerTick) ||
    estimatedServerTick < 0 ||
    !Number.isSafeInteger(target)
  )
    throw new Error("estimated server tick is invalid");
  return target;
}
