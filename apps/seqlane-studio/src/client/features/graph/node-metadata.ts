import type { StudioInvocationSnapshot } from "@seqlane/studio/protocol";

export interface InvocationNodeMetadata {
  readonly duration?: string;
  readonly tokens?: string;
  readonly cost?: string;
  readonly inputState?: string;
  readonly resultState?: string;
  readonly validation?: string;
  readonly validationEvidence?: string;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(2).replace(/\.00$/, "")} s`;
  }
  if (durationMs < 3_600_000) {
    return `${(durationMs / 60_000).toFixed(1).replace(/\.0$/, "")} min`;
  }
  return `${(durationMs / 3_600_000).toFixed(1).replace(/\.0$/, "")} h`;
}

function durationOf(invocation: StudioInvocationSnapshot): number | undefined {
  const metricDuration = invocation.output.metrics?.durationMs;
  if (metricDuration !== undefined) return metricDuration;
  if (
    invocation.startedAt === undefined ||
    invocation.finishedAt === undefined
  ) {
    return undefined;
  }
  const duration =
    Date.parse(invocation.finishedAt) - Date.parse(invocation.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function formatTokens(
  invocation: StudioInvocationSnapshot,
): string | undefined {
  const tokens = invocation.output.metrics?.tokens;
  if (tokens === undefined) return undefined;
  const total = tokens.total ?? tokens.input + tokens.output + tokens.reasoning;
  if (total < 1_000) return `${total} tok`;
  return `${(total / 1_000).toFixed(1).replace(/\.0$/, "")}k tok`;
}

function formatCost(invocation: StudioInvocationSnapshot): string | undefined {
  const cost = invocation.output.metrics?.cost;
  if (cost === undefined) return undefined;
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function formatDisplayState(
  value: StudioInvocationSnapshot["input"],
): string | undefined {
  return value === undefined ? undefined : value.state;
}

function formatValidation(
  invocation: StudioInvocationSnapshot,
): string | undefined {
  const validation = invocation.validation;
  if (validation === undefined) return undefined;
  return `validation ${validation.sourceId} · ${validation.verdict}${
    validation.continued ? " · repeat continues" : ""
  }`;
}

function formatValidationEvidence(
  invocation: StudioInvocationSnapshot,
): string | undefined {
  const evidence = invocation.validation?.evidence;
  return evidence === undefined ? undefined : `evidence ${evidence.state}`;
}

export function invocationNodeMetadata(
  invocation: StudioInvocationSnapshot,
): InvocationNodeMetadata {
  const duration = durationOf(invocation);
  return {
    duration: duration === undefined ? undefined : formatDuration(duration),
    tokens: formatTokens(invocation),
    cost: formatCost(invocation),
    inputState: formatDisplayState(invocation.input),
    resultState: formatDisplayState(invocation.result),
    validation: formatValidation(invocation),
    validationEvidence: formatValidationEvidence(invocation),
  };
}

export function formatInvocationNodeLabel(
  invocation: StudioInvocationSnapshot,
): string {
  const metadata = invocationNodeMetadata(invocation);
  const details = [
    metadata.duration,
    metadata.tokens,
    metadata.cost,
    metadata.inputState === undefined ? undefined : `in ${metadata.inputState}`,
    metadata.resultState === undefined
      ? undefined
      : `out ${metadata.resultState}`,
    metadata.validation,
    metadata.validationEvidence,
  ].filter((value): value is string => value !== undefined);
  return [invocation.label, invocation.state, details.join(" · ")]
    .filter((value) => value.length > 0)
    .join("\n");
}
