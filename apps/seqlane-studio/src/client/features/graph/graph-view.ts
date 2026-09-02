import type {
  StudioInvocationSnapshot,
  StudioRunState,
} from "@seqlane/studio/protocol";

export const studioGraphViewport = {
  initialMinZoom: 0.6,
  maxZoom: 1.5,
  minZoom: 0.15,
  padding: 0.05,
} as const;

export interface GraphRunState {
  readonly runId: string;
  readonly state: StudioRunState;
}

export function focusInvocationId(
  invocations: readonly StudioInvocationSnapshot[],
  selectedInvocationId: string | undefined,
): string | undefined {
  return (
    invocations.find(({ state }) => state === "active" || state === "retrying")
      ?.invocationId ??
    selectedInvocationId ??
    invocations.at(-1)?.invocationId
  );
}

const terminalRunStates = new Set<StudioRunState>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function shouldRefitGraph(
  previous: GraphRunState | undefined,
  current: GraphRunState,
): boolean {
  if (previous === undefined || previous.runId !== current.runId) return true;
  return (
    previous.state !== current.state && terminalRunStates.has(current.state)
  );
}
