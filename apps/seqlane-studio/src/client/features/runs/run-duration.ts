function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function formatMilliseconds(duration: number): string {
  if (duration < 1_000) return `${Math.round(duration)} ms`;
  if (duration < 60_000) {
    const precision = duration < 10_000 ? 2 : 1;
    return `${(duration / 1_000).toFixed(precision).replace(/\.0+$/, "")} s`;
  }
  const totalSeconds = Math.round(duration / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatRunDuration(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  currentTime = Date.now(),
): string | undefined {
  const start = timestamp(startedAt);
  const finish = timestamp(finishedAt) ?? currentTime;
  if (start === undefined || finish < start) return undefined;
  return formatMilliseconds(finish - start);
}
