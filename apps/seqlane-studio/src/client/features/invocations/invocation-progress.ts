import type {
  StudioInvocationSnapshot,
  StudioRunSnapshot,
} from "@seqlane/studio/protocol";

const finishedStates = new Set<StudioInvocationSnapshot["state"]>([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

export interface InvocationProgress {
  readonly total: number;
  readonly finished: number;
  readonly percent: number;
  readonly current: readonly StudioInvocationSnapshot[];
}

export function invocationProgress(
  snapshot: StudioRunSnapshot,
): InvocationProgress {
  const total = snapshot.invocations.length;
  const finished = snapshot.invocations.filter(({ state }) =>
    finishedStates.has(state),
  ).length;
  return {
    total,
    finished,
    percent: total === 0 ? 0 : Math.round((finished / total) * 100),
    current: snapshot.invocations.filter(
      ({ state }) => state === "active" || state === "retrying",
    ),
  };
}
