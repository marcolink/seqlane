import type { SeqlaneEvent } from "@seqlane/core";
import { z } from "zod";

const tokenMetricsSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
  })
  .strict();

const taskMetricsSchema = z
  .object({
    invocationId: z.string().min(1),
    task: z.string().min(1),
    taskId: z.string().min(1).optional(),
    resultState: z.enum([
      "queued",
      "waiting",
      "active",
      "retrying",
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
    ]),
    durationMs: z.number().nonnegative(),
    model: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    tokens: tokenMetricsSchema.optional(),
    cost: z.number().nonnegative().optional(),
  })
  .strict();

export const reviewRunMetricsSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    durationMs: z.number().nonnegative(),
    totalCost: z.number().nonnegative(),
    totalTokens: tokenMetricsSchema.extend({
      total: z.number().int().nonnegative(),
    }),
    tasks: z.array(taskMetricsSchema).max(40),
  })
  .strict();

export type ReviewRunMetrics = z.infer<typeof reviewRunMetricsSchema>;

export function deriveRunMetrics(
  events: readonly SeqlaneEvent[],
  runId: string,
): ReviewRunMetrics {
  type InvocationOutput = Extract<SeqlaneEvent, { type: "invocation.output" }>;
  type InvocationResult = Extract<
    SeqlaneEvent,
    {
      type:
        | "invocation.succeeded"
        | "invocation.failed"
        | "invocation.skipped"
        | "invocation.cancelled";
    }
  >;
  const createdTasks: Array<
    Extract<SeqlaneEvent, { type: "invocation.created" }>
  > = [];
  const latestOutputs = new Map<string, InvocationOutput>();
  const latestResults = new Map<string, InvocationResult>();
  let ended:
    | Extract<
        SeqlaneEvent,
        { type: "run.succeeded" | "run.failed" | "run.cancelled" }
      >
    | undefined;
  // The public event contract intentionally does not expose wall-clock
  // metadata. Runtime-provided task durations remain authoritative; the
  // direct Action records zero when no duration is available instead of
  // pretending that the largest task duration is the run duration.
  const durationMs = 0;
  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let totalCost = 0;
  for (const event of events) {
    if (
      event.type === "run.succeeded" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      ended = event;
    }
    if (event.type === "invocation.created" && event.kind === "task") {
      createdTasks.push(event);
    }
    if (event.type === "invocation.output") {
      latestOutputs.set(event.invocationId, event);
    }
    if (
      event.type === "invocation.succeeded" ||
      event.type === "invocation.failed" ||
      event.type === "invocation.skipped" ||
      event.type === "invocation.cancelled"
    ) {
      latestResults.set(event.invocationId, event);
    }
    if (event.type !== "invocation.output" || event.metrics === undefined)
      continue;
    const tokens = event.metrics.tokens;
    if (tokens !== undefined) {
      totals.input += tokens.input;
      totals.output += tokens.output;
      totals.reasoning += tokens.reasoning;
      totals.cacheRead += tokens.cacheRead;
      totals.cacheWrite += tokens.cacheWrite;
    }
    totalCost += event.metrics.cost ?? 0;
  }

  const outcome =
    ended?.type === "run.succeeded"
      ? "succeeded"
      : ended?.type === "run.cancelled"
        ? "cancelled"
        : "failed";

  const taskEntries = createdTasks
    .map((created) => {
      const output = latestOutputs.get(created.invocationId);
      const result = latestResults.get(created.invocationId);
      const resultState =
        result?.type === "invocation.succeeded"
          ? ("succeeded" as const)
          : result?.type === "invocation.failed"
            ? ("failed" as const)
            : result?.type === "invocation.skipped"
              ? ("skipped" as const)
              : result?.type === "invocation.cancelled"
                ? ("cancelled" as const)
                : undefined;
      if (resultState === undefined) return undefined;
      const taskMetrics =
        output?.type === "invocation.output" ? output.metrics : undefined;
      const modelSelection = taskMetrics?.modelSelection;
      const hasMeasuredUsage =
        taskMetrics?.durationMs !== undefined ||
        taskMetrics?.cost !== undefined ||
        taskMetrics?.tokens !== undefined;
      return {
        invocationId: created.invocationId,
        task: created.label,
        ...(created.taskId === undefined ? {} : { taskId: created.taskId }),
        resultState,
        durationMs: taskMetrics?.durationMs ?? 0,
        ...(taskMetrics?.model !== undefined
          ? {
              model: taskMetrics.model,
            }
          : !hasMeasuredUsage && modelSelection?.model.model !== undefined
            ? {
                model: modelSelection.model.model,
              }
            : {}),
        ...(taskMetrics?.provider !== undefined
          ? {
              provider: taskMetrics.provider,
            }
          : !hasMeasuredUsage && modelSelection?.model.provider !== undefined
            ? {
                provider: modelSelection.model.provider,
              }
            : {}),
        ...(taskMetrics?.tokens === undefined
          ? {}
          : { tokens: taskMetrics.tokens }),
        ...(taskMetrics?.cost === undefined ? {} : { cost: taskMetrics.cost }),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return {
    schemaVersion: 1,
    runId,
    outcome,
    durationMs,
    totalCost,
    totalTokens: {
      ...totals,
      total: Object.values(totals).reduce((sum, value) => sum + value, 0),
    },
    tasks: taskEntries,
  };
}
