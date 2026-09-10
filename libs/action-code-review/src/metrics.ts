import type { SeqlaneEvent } from "@seqlane/core";
import { z } from "zod";

const eventBaseSchema = z
  .object({ workId: z.string().min(1), runId: z.string().min(1) })
  .strict();

const invocationMetricsSchema = z
  .object({
    durationMs: z.number().nonnegative().optional(),
    model: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    modelSelection: z
      .object({
        model: z.object({
          provider: z.string().min(1),
          model: z.string().min(1),
        }),
        reasoning: z
          .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
          .optional(),
      })
      .strict()
      .optional(),
    tokens: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        reasoning: z.number().int().nonnegative(),
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
        total: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    cost: z.number().nonnegative().optional(),
  })
  .strict();

export const reviewRunSkillUsageSchema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(256),
        count: z.number().int().positive(),
      })
      .strict(),
  )
  .max(128);

/** The Action-private event projection used by the model-free publication workflow. */
export const reviewMetricEventSchema = z.discriminatedUnion("type", [
  eventBaseSchema.extend({
    type: z.literal("run.heartbeat"),
    elapsedMs: z.number().nonnegative(),
  }),
  eventBaseSchema.extend({ type: z.literal("run.succeeded") }),
  eventBaseSchema.extend({ type: z.literal("run.failed") }),
  eventBaseSchema.extend({ type: z.literal("run.cancelled") }),
  eventBaseSchema.extend({
    type: z.literal("invocation.created"),
    invocationId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    label: z.string().min(1),
  }),
  eventBaseSchema.extend({
    type: z.literal("invocation.output"),
    invocationId: z.string().min(1),
    metrics: invocationMetricsSchema.optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal("invocation.activity"),
    invocationId: z.string().min(1),
    activityId: z.string().min(1).max(256),
    kind: z.literal("skill"),
    name: z.string().min(1).max(256),
    state: z.enum(["started", "progress", "succeeded", "failed"]),
  }),
  ...(["succeeded", "failed", "skipped", "cancelled"] as const).map((state) =>
    eventBaseSchema.extend({
      type: z.literal(`invocation.${state}` as `invocation.${typeof state}`),
      invocationId: z.string().min(1),
    }),
  ),
]);

export type ReviewMetricEvent = z.infer<typeof reviewMetricEventSchema>;

/** Drops review inputs, outputs, and activity payloads before publication retention. */
export function projectReviewMetricEvent(
  event: SeqlaneEvent,
): ReviewMetricEvent | undefined {
  const base = { workId: event.workId, runId: event.runId };
  switch (event.type) {
    case "run.heartbeat":
      return { ...base, type: event.type, elapsedMs: event.elapsedMs };
    case "run.succeeded":
    case "run.failed":
    case "run.cancelled":
      return { ...base, type: event.type };
    case "invocation.created":
      return event.kind === "task"
        ? {
            ...base,
            type: event.type,
            invocationId: event.invocationId,
            ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
            label: event.label,
          }
        : undefined;
    case "invocation.output":
      return {
        ...base,
        type: event.type,
        invocationId: event.invocationId,
        ...(event.metrics === undefined ? {} : { metrics: event.metrics }),
      };
    case "invocation.activity":
      return event.kind === "skill"
        ? {
            ...base,
            type: event.type,
            invocationId: event.invocationId,
            activityId: event.activityId,
            kind: event.kind,
            name: event.name,
            state: event.state,
          }
        : undefined;
    case "invocation.succeeded":
    case "invocation.failed":
    case "invocation.skipped":
    case "invocation.cancelled":
      return { ...base, type: event.type, invocationId: event.invocationId };
    default:
      return undefined;
  }
}

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
    skills: reviewRunSkillUsageSchema.optional(),
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
  events: readonly ReviewMetricEvent[] | readonly SeqlaneEvent[],
  runId: string,
): ReviewRunMetrics {
  type InvocationOutput = Extract<
    ReviewMetricEvent,
    { type: "invocation.output" }
  >;
  type InvocationResult = Extract<
    ReviewMetricEvent,
    {
      type:
        | "invocation.succeeded"
        | "invocation.failed"
        | "invocation.skipped"
        | "invocation.cancelled";
    }
  >;
  const createdTasks: Array<
    Extract<ReviewMetricEvent, { type: "invocation.created" }>
  > = [];
  const latestOutputs = new Map<string, InvocationOutput>();
  const latestResults = new Map<string, InvocationResult>();
  const skillActivities = new Map<string, Map<string, string>>();
  let latestHeartbeatElapsedMs = 0;
  let ended:
    | Extract<
        ReviewMetricEvent,
        { type: "run.succeeded" | "run.failed" | "run.cancelled" }
      >
    | undefined;
  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let totalCost = 0;
  const metricEvents = events.flatMap((event) => {
    const parsed = reviewMetricEventSchema.safeParse(event);
    return parsed.success
      ? [parsed.data]
      : [projectReviewMetricEvent(event as SeqlaneEvent)].filter(
          (value): value is ReviewMetricEvent => value !== undefined,
        );
  });
  for (const event of metricEvents) {
    if (
      event.type === "run.succeeded" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      ended = event;
    }
    if (event.type === "invocation.created") {
      createdTasks.push(event);
    }
    if (event.type === "invocation.output") {
      latestOutputs.set(event.invocationId, event);
    }
    if (event.type === "invocation.activity") {
      const activities =
        skillActivities.get(event.invocationId) ?? new Map<string, string>();
      if (!activities.has(event.activityId) && activities.size < 128)
        activities.set(event.activityId, event.name);
      skillActivities.set(event.invocationId, activities);
    }
    if (event.type === "run.heartbeat") {
      latestHeartbeatElapsedMs = Math.max(
        latestHeartbeatElapsedMs,
        event.elapsedMs,
      );
    }
    if (
      event.type === "invocation.succeeded" ||
      event.type === "invocation.failed" ||
      event.type === "invocation.skipped" ||
      event.type === "invocation.cancelled"
    ) {
      latestResults.set(event.invocationId, event);
    }
  }

  for (const output of latestOutputs.values()) {
    const metrics = output.metrics;
    if (metrics === undefined) continue;
    const tokens = metrics.tokens;
    if (tokens !== undefined) {
      totals.input += tokens.input;
      totals.output += tokens.output;
      totals.reasoning += tokens.reasoning;
      totals.cacheRead += tokens.cacheRead;
      totals.cacheWrite += tokens.cacheWrite;
    }
    totalCost += metrics.cost ?? 0;
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
      const activities = skillActivities.get(created.invocationId);
      const skills =
        activities === undefined
          ? undefined
          : [...new Set(activities.values())]
              .map((name) => ({
                name,
                count: [...activities.values()].filter(
                  (activityName) => activityName === name,
                ).length,
              }))
              .sort((left, right) => left.name.localeCompare(right.name));
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
        ...(skills === undefined || skills.length === 0 ? {} : { skills }),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const durationMs = Math.max(
    latestHeartbeatElapsedMs,
    ...taskEntries.map((entry) => entry.durationMs),
  );
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
