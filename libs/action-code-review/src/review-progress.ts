import type { SeqlaneEvent } from "@seqlane/core";

const MAX_IDENTIFIER_LENGTH = 80;
const MAX_PROGRESS_LINE_LENGTH = 240;

export type ReviewTaskStatus = "succeeded" | "failed" | "skipped" | "cancelled";

export interface ReviewTaskMetrics {
  readonly durationMs?: number;
  readonly cost?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export type ReviewProgressEvent =
  | { readonly kind: "review-started"; readonly headRevision: string }
  | {
      readonly kind: "task-started";
      readonly label: string;
      readonly taskId?: string;
    }
  | {
      readonly kind: "task-completed";
      readonly label: string;
      readonly taskId?: string;
      readonly status: ReviewTaskStatus;
      readonly metrics?: ReviewTaskMetrics;
    }
  | {
      readonly kind: "review-completed";
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly elapsedMs: number;
    };

export interface ReviewProgressPort {
  readonly write: (event: ReviewProgressEvent) => void;
}

function safeIdentifier(value: string | undefined, fallback: string): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  )
    return fallback;
  return value;
}

function safeHead(value: string): string {
  return /^[0-9a-f]{7,}$/i.test(value) ? value.slice(0, 7) : "unknown";
}

function safeMetric(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function formatDuration(milliseconds: number): string {
  const safeMilliseconds = safeMetric(milliseconds) ?? 0;
  type DurationUnit = "millisecond" | "second" | "minute";
  const units: ReadonlyArray<{
    readonly limit: number;
    readonly divisor: number;
    readonly unit: DurationUnit;
  }> = [
    { limit: 1_000, divisor: 1, unit: "millisecond" },
    { limit: 60_000, divisor: 1_000, unit: "second" },
    { limit: Number.POSITIVE_INFINITY, divisor: 60_000, unit: "minute" },
  ];
  const fallbackUnit: (typeof units)[number] = {
    limit: Number.POSITIVE_INFINITY,
    divisor: 60_000,
    unit: "minute",
  };
  const { divisor, unit } =
    units.find(({ limit }) => safeMilliseconds < limit) ?? fallbackUnit;
  return new Intl.NumberFormat("en", {
    style: "unit",
    unit,
    unitDisplay: "narrow",
    maximumFractionDigits: 1,
  }).format(safeMilliseconds / divisor);
}

function formatTaskIdentity(label: string, taskId: string | undefined): string {
  const safeLabel = safeIdentifier(label, "unknown-task");
  const safeTaskId = safeIdentifier(taskId, "unknown-task-id");
  return taskId === undefined ? safeLabel : `${safeLabel} (${safeTaskId})`;
}

function boundedLine(line: string): string {
  return line.length > MAX_PROGRESS_LINE_LENGTH
    ? line.slice(0, MAX_PROGRESS_LINE_LENGTH)
    : line;
}

export function formatReviewProgressEvent(event: ReviewProgressEvent): string {
  switch (event.kind) {
    case "review-started":
      return boundedLine(
        `Seqlane review started: head=${safeHead(event.headRevision)}.`,
      );
    case "task-started":
      return boundedLine(
        `Task started: ${formatTaskIdentity(event.label, event.taskId)}.`,
      );
    case "task-completed": {
      const details = [`status=${event.status}`];
      const durationMs = safeMetric(event.metrics?.durationMs);
      const cost = safeMetric(event.metrics?.cost);
      const inputTokens = safeMetric(event.metrics?.inputTokens);
      const outputTokens = safeMetric(event.metrics?.outputTokens);
      const totalTokens = safeMetric(event.metrics?.totalTokens);
      if (durationMs !== undefined)
        details.push(`duration=${formatDuration(durationMs)}`);
      if (cost !== undefined) details.push(`cost=$${cost.toFixed(4)}`);
      if (inputTokens !== undefined)
        details.push(
          `inputTokens=${Math.floor(inputTokens).toLocaleString("en-US")}`,
        );
      if (outputTokens !== undefined)
        details.push(
          `outputTokens=${Math.floor(outputTokens).toLocaleString("en-US")}`,
        );
      if (totalTokens !== undefined)
        details.push(
          `tokens=${Math.floor(totalTokens).toLocaleString("en-US")}`,
        );
      return boundedLine(
        `Task completed: ${formatTaskIdentity(event.label, event.taskId)} — ${details.join("; ")}.`,
      );
    }
    case "review-completed":
      return boundedLine(
        `Seqlane review completed: status=${event.status} — ${formatDuration(event.elapsedMs)} elapsed.`,
      );
  }
}

function totalTokens(tokens: {
  readonly total?: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}): number | undefined {
  const total =
    tokens.total ??
    tokens.input +
      tokens.output +
      tokens.reasoning +
      tokens.cacheRead +
      tokens.cacheWrite;
  return safeMetric(total);
}

/** Converts runtime events into bounded, console-safe lifecycle events. */
export function createReviewProgress(
  port: ReviewProgressPort | undefined,
  options: { readonly headRevision: string; readonly now?: () => number },
): {
  readonly emit: (event: SeqlaneEvent) => void;
  readonly complete: (status: "succeeded" | "failed" | "cancelled") => void;
} {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const taskLabels = new Map<
    string,
    { readonly label: string; readonly taskId?: string }
  >();
  const startedTasks = new Set<string>();
  const completedTasks = new Set<string>();
  const pendingTerminalTasks = new Map<string, ReviewTaskStatus>();
  const outputs = new Map<
    string,
    Extract<SeqlaneEvent, { type: "invocation.output" }>["metrics"]
  >();
  let reviewStarted = false;
  let reviewCompleted = false;

  const write = (event: ReviewProgressEvent): void => {
    try {
      port?.write(event);
    } catch {
      // Progress output is best-effort and must not affect review execution.
    }
  };

  const emitTaskCompleted = (
    invocationId: string,
    status: ReviewTaskStatus,
  ): void => {
    if (completedTasks.has(invocationId) || !taskLabels.has(invocationId))
      return;
    completedTasks.add(invocationId);
    const task = taskLabels.get(invocationId)!;
    const metrics = outputs.get(invocationId);
    write({
      kind: "task-completed",
      ...task,
      status,
      ...(metrics === undefined
        ? {}
        : {
            metrics: {
              ...(metrics.durationMs === undefined
                ? {}
                : { durationMs: metrics.durationMs }),
              ...(metrics.cost === undefined ? {} : { cost: metrics.cost }),
              ...(metrics.tokens === undefined
                ? {}
                : {
                    inputTokens: safeMetric(metrics.tokens.input),
                    outputTokens: safeMetric(metrics.tokens.output),
                    totalTokens: totalTokens(metrics.tokens),
                  }),
            },
          }),
    });
  };

  const complete = (status: "succeeded" | "failed" | "cancelled"): void => {
    for (const [invocationId, taskStatus] of pendingTerminalTasks) {
      pendingTerminalTasks.delete(invocationId);
      emitTaskCompleted(invocationId, taskStatus);
    }
    if (reviewCompleted) return;
    reviewCompleted = true;
    write({
      kind: "review-completed",
      status,
      elapsedMs: Math.max(0, now() - startedAt),
    });
  };

  const emit = (event: SeqlaneEvent): void => {
    if (event.type === "run.started") {
      if (reviewStarted) return;
      reviewStarted = true;
      write({ kind: "review-started", headRevision: options.headRevision });
      return;
    }
    if (event.type === "invocation.created" && event.kind === "task") {
      taskLabels.set(event.invocationId, {
        label: event.label,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      });
      return;
    }
    if (event.type === "invocation.output") {
      if (event.metrics !== undefined)
        outputs.set(event.invocationId, event.metrics);
      const pendingStatus = pendingTerminalTasks.get(event.invocationId);
      if (pendingStatus !== undefined) {
        pendingTerminalTasks.delete(event.invocationId);
        emitTaskCompleted(event.invocationId, pendingStatus);
      }
      return;
    }
    if (
      event.type === "invocation.started" &&
      !startedTasks.has(event.invocationId) &&
      (taskLabels.has(event.invocationId) || event.subject.type === "task")
    ) {
      const task = taskLabels.get(event.invocationId) ?? {
        label: event.taskId ?? "unknown-task",
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      };
      startedTasks.add(event.invocationId);
      write({ kind: "task-started", ...task });
      return;
    }
    const terminalEvent =
      event.type === "invocation.succeeded" ||
      (event.type === "invocation.failed" &&
        event.disposition !== "retry_scheduled") ||
      event.type === "invocation.skipped" ||
      event.type === "invocation.cancelled"
        ? event
        : undefined;
    const status: ReviewTaskStatus | undefined =
      event.type === "invocation.succeeded"
        ? "succeeded"
        : event.type === "invocation.failed" &&
            event.disposition !== "retry_scheduled"
          ? "failed"
          : event.type === "invocation.skipped"
            ? "skipped"
            : event.type === "invocation.cancelled"
              ? "cancelled"
              : undefined;
    if (
      terminalEvent !== undefined &&
      status !== undefined &&
      taskLabels.has(terminalEvent.invocationId)
    ) {
      if (status === "succeeded" && !outputs.has(terminalEvent.invocationId))
        pendingTerminalTasks.set(terminalEvent.invocationId, status);
      else emitTaskCompleted(terminalEvent.invocationId, status);
      return;
    }
    if (event.type === "run.succeeded") complete("succeeded");
    else if (event.type === "run.failed") complete("failed");
    else if (event.type === "run.cancelled") complete("cancelled");
  };

  return { emit, complete };
}
