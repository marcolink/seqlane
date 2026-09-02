import { z } from "zod";
import type {
  StudioReplayPayload,
  StudioRunSnapshot,
  StudioRunsSnapshot,
  StudioStreamEvent,
} from "@seqlane/studio/protocol";
import { seqlaneExecutionEventSchema } from "@seqlane/studio/protocol";

const nonEmptyStringSchema = z.string().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const recordSchema = z.looseObject({});
const nonEmptyStringArraySchema = z.array(nonEmptyStringSchema);

const displayValueSchema = z.looseObject({
  state: z.enum(["present", "redacted", "truncated", "omitted"]),
});

const activitySchema = z.looseObject({
  activityId: nonEmptyStringSchema,
  kind: z.enum(["tool", "skill"]),
  name: nonEmptyStringSchema.max(256),
  state: z.enum(["started", "progress", "succeeded", "failed"]),
  input: displayValueSchema.optional(),
  output: displayValueSchema.optional(),
  activityMetadata: displayValueSchema.optional(),
  startedAt: nonNegativeIntegerSchema.optional(),
  endedAt: nonNegativeIntegerSchema.optional(),
  message: z.string().max(2_000).optional(),
  iteration: positiveIntegerSchema.optional(),
  occurredAt: nonEmptyStringSchema,
});

const toolUsageSchema = z.looseObject({
  name: nonEmptyStringSchema.max(256),
  count: nonNegativeIntegerSchema,
});

const validationSchema = z.looseObject({
  validationNodeId: nonEmptyStringSchema,
  sourceId: nonEmptyStringSchema,
  sourceType: z.enum(["validator", "evaluator", "validation-gate"]),
  verdict: z.enum(["passed", "failed", "unknown"]),
  issues: z.array(
    z.looseObject({
      code: nonEmptyStringSchema,
      message: nonEmptyStringSchema,
    }),
  ),
  continued: z.boolean(),
  evidence: displayValueSchema.optional(),
});

const outputSchema = z.looseObject({
  persistent: z.array(z.string()),
});

const invocationSchema = z.looseObject({
  invocationId: nonEmptyStringSchema,
  planNodeId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  kind: z.enum(["workflow", "loop", "task", "validation"]),
  label: nonEmptyStringSchema,
  siblingOrder: nonNegativeIntegerSchema,
  dependencyIds: nonEmptyStringArraySchema,
  state: z.enum([
    "queued",
    "waiting",
    "active",
    "retrying",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
  ]),
  output: outputSchema,
  parentInvocationId: z.string().optional(),
  iteration: positiveIntegerSchema.optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  input: displayValueSchema.optional(),
  result: displayValueSchema.optional(),
  activities: z.array(activitySchema).max(100).optional(),
  validation: validationSchema.optional(),
  error: recordSchema.optional(),
});

const planSchema = z.looseObject({
  workflow: z.looseObject({ id: nonEmptyStringSchema }),
  nodes: z.array(
    z.looseObject({
      planNodeId: nonEmptyStringSchema,
      type: z.enum(["task", "validation.check", "validation.gate", "repeat"]),
      label: nonEmptyStringSchema,
      dependsOn: nonEmptyStringArraySchema,
      siblingOrder: nonNegativeIntegerSchema,
      taskId: z.string().optional(),
      session: z
        .union([
          z.strictObject({ type: z.literal("isolated") }),
          z.strictObject({
            type: z.enum(["reuse", "branch"]),
            from: nonEmptyStringSchema,
          }),
        ])
        .optional(),
      parentPlanNodeId: z.string().optional(),
      maximumIterations: nonNegativeIntegerSchema.optional(),
    }),
  ),
});

const runSummarySchema = z.looseObject({
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
  state: z.enum(["active", "succeeded", "failed", "cancelled"]),
  isIncomplete: z.boolean(),
  activeInvocationCount: nonNegativeIntegerSchema,
  lastEventSequence: nonNegativeIntegerSchema,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

const runsSnapshotSchema = z.looseObject({
  cursor: nonNegativeIntegerSchema,
  runs: z.array(runSummarySchema),
});

const runSnapshotSchema = z.looseObject({
  summary: runSummarySchema,
  cursor: nonNegativeIntegerSchema,
  invocations: z.array(invocationSchema),
  toolUsage: z.array(toolUsageSchema).optional(),
  skillUsage: z.array(toolUsageSchema).optional(),
  plan: planSchema.optional(),
});

const studioStreamEventSchema = z.looseObject({
  cursor: nonNegativeIntegerSchema,
  workflowId: nonEmptyStringSchema,
  event: seqlaneExecutionEventSchema,
});

const replayPayloadSchema = z.looseObject({
  replayId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
  fileName: nonEmptyStringSchema,
  events: z.array(studioStreamEventSchema).min(1),
});

function parseSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  message: string,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(message);
  }
  return result.data as z.output<TSchema>;
}

export function parseStudioRunsSnapshot(value: unknown): StudioRunsSnapshot {
  return parseSchema(
    runsSnapshotSchema,
    value,
    "Studio runs response has an invalid shape",
  ) as StudioRunsSnapshot;
}

export function parseStudioRunSnapshot(value: unknown): StudioRunSnapshot {
  return parseSchema(
    runSnapshotSchema,
    value,
    "Studio run response has an invalid shape",
  ) as StudioRunSnapshot;
}

export function parseStudioStreamEvent(data: string): StudioStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("Studio stream event must be valid JSON");
  }
  return parseSchema(
    studioStreamEventSchema,
    value,
    "Studio stream event has an invalid shape",
  ) as StudioStreamEvent;
}

export function parseStudioReplayPayload(value: unknown): StudioReplayPayload {
  return parseSchema(
    replayPayloadSchema,
    value,
    "Studio replay response has an invalid shape",
  ) as StudioReplayPayload;
}

export interface StudioTransport {
  loadRuns(): Promise<StudioRunsSnapshot>;
  loadRun(runId: string): Promise<StudioRunSnapshot>;
  loadReplay(replayId: string): Promise<StudioReplayPayload>;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function fetchJson<T>(
  fetcher: Fetcher,
  path: string,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetcher(path, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Studio request failed (${response.status})`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Studio response must be valid JSON");
  }
  return parse(value);
}

export function createStudioTransport(
  fetcher: Fetcher = (input, init) => fetch(input, init),
): StudioTransport {
  return {
    async loadRuns() {
      return fetchJson(fetcher, "/api/runs", parseStudioRunsSnapshot);
    },
    async loadRun(runId) {
      return fetchJson(
        fetcher,
        `/api/runs/${encodeURIComponent(runId)}`,
        parseStudioRunSnapshot,
      );
    },
    async loadReplay(replayId) {
      return fetchJson(
        fetcher,
        `/api/replay/${encodeURIComponent(replayId)}`,
        parseStudioReplayPayload,
      );
    },
  };
}
