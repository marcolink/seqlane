import {
  jsonValueSchema,
  isPlainRecord,
  modelSelectionSchema,
  plainRecordSchema,
} from "@seqlane/core";
import { z } from "zod";

function strictRecord<T extends z.ZodRawShape>(shape: T) {
  const objectSchema = z.strictObject(shape);

  return plainRecordSchema.pipe(objectSchema).pipe(
    z.custom<z.output<typeof objectSchema>>((value) => {
      if (!isPlainRecord(value)) return false;
      return Object.keys(value).every(
        (key) =>
          Object.getOwnPropertyDescriptor(value, key)?.value !== undefined,
      );
    }),
  );
}

const nonEmptyStringSchema = z.string().min(1);
const boundedString = (maximum: number) => nonEmptyStringSchema.max(maximum);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeNumberSchema = z.number().nonnegative();

function arrayOf<T>(
  itemSchema: z.ZodType<T>,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
) {
  let schema = z.array(itemSchema);
  if (options.minimum !== undefined) schema = schema.min(options.minimum);
  if (options.maximum !== undefined) schema = schema.max(options.maximum);
  return schema;
}

const isoUtcTimestampSchema = z.iso.datetime({ precision: 3 });

const traceparentSchema = z
  .string()
  .regex(/^[\da-f]{2}-(?!0{32})[\da-f]{32}-(?!0{16})[\da-f]{16}-[\da-f]{2}$/);

const tracestateSchema = z
  .string()
  .max(512)
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,255}=[\x20-\x7e]{0,256}(?:,[a-z0-9][a-z0-9_-]{0,255}=[\x20-\x7e]{0,256})*$/,
  );

const metadataSchema = strictRecord({
  schemaVersion: z.literal(1),
  eventId: nonEmptyStringSchema,
  sequence: nonNegativeIntegerSchema,
  occurredAt: isoUtcTimestampSchema,
  traceparent: traceparentSchema.optional(),
  tracestate: tracestateSchema.optional(),
});

const taskSubjectSchema = strictRecord({
  type: z.literal("task"),
  taskId: nonEmptyStringSchema,
});
const validatorSubjectSchema = strictRecord({
  type: z.literal("validator"),
  validatorId: nonEmptyStringSchema,
});
const validationGateSubjectSchema = strictRecord({
  type: z.literal("validation-gate"),
  planNodeId: nonEmptyStringSchema,
});
const choiceSubjectSchema = strictRecord({
  type: z.literal("choice"),
  planNodeId: nonEmptyStringSchema,
});
const subjectSchema = z.union([
  taskSubjectSchema,
  validatorSubjectSchema,
  choiceSubjectSchema,
  validationGateSubjectSchema,
]);

const outputSummarySchema = strictRecord({
  kind: z.enum(["null", "boolean", "number", "string", "array", "object"]),
  size: nonNegativeIntegerSchema.optional(),
  fields: arrayOf(z.string().max(80), { maximum: 8 }).optional(),
});

const displayValueSchema = z.union([
  strictRecord({
    state: z.literal("present"),
    value: jsonValueSchema,
  }),
  strictRecord({
    state: z.literal("redacted"),
    summary: outputSummarySchema.optional(),
  }),
  strictRecord({
    state: z.literal("truncated"),
    summary: outputSummarySchema,
  }),
  strictRecord({
    state: z.literal("omitted"),
    reason: z.enum(["policy", "unavailable"]),
  }),
]);

const invocationTokensSchema = strictRecord({
  input: nonNegativeIntegerSchema,
  output: nonNegativeIntegerSchema,
  reasoning: nonNegativeIntegerSchema,
  cacheRead: nonNegativeIntegerSchema,
  cacheWrite: nonNegativeIntegerSchema,
  total: nonNegativeIntegerSchema.optional(),
});

const metricsSchema = strictRecord({
  durationMs: nonNegativeNumberSchema.optional(),
  model: nonEmptyStringSchema.optional(),
  provider: nonEmptyStringSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  cost: nonNegativeNumberSchema.optional(),
  tokens: invocationTokensSchema.optional(),
});

export const validationIssueSchema = strictRecord({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});

export type ValidationIssue = z.output<typeof validationIssueSchema>;

const seqlaneErrorCategorySchema = z.enum([
  "InputValidationError",
  "ExecutorError",
  "OutputValidationError",
  "ValidationError",
  "RuntimeError",
]);

const optionalMetadataField = <T>(schema: z.ZodType<T>) =>
  z.union([schema, z.unknown().transform(() => undefined)]).optional();

/** Safely projects known fields from an Error without trusting its shape. */
export const seqlaneErrorMetadataSchema = z.looseObject({
  category: optionalMetadataField(seqlaneErrorCategorySchema),
  taskId: optionalMetadataField(nonEmptyStringSchema),
  nodeId: optionalMetadataField(nonEmptyStringSchema),
  sourceId: optionalMetadataField(nonEmptyStringSchema),
  issues: optionalMetadataField(z.array(validationIssueSchema).nonempty()),
});

const serializedValidationFailureSchema = strictRecord({
  validationNodeId: nonEmptyStringSchema,
  sourceId: nonEmptyStringSchema,
  issues: arrayOf(validationIssueSchema, { minimum: 1 }),
  evidence: displayValueSchema.optional(),
});

export const serializedSeqlaneErrorSchema = strictRecord({
  category: seqlaneErrorCategorySchema,
  message: z.string(),
  taskId: nonEmptyStringSchema.optional(),
  validation: serializedValidationFailureSchema.optional(),
});

const isolatedPlanSessionSchema = strictRecord({
  type: z.literal("isolated"),
  model: modelSelectionSchema.optional(),
});
const branchPlanSessionSchema = strictRecord({
  type: z.literal("branch"),
  from: boundedString(256),
  model: modelSelectionSchema.optional(),
});
const reusePlanSessionSchema = strictRecord({
  type: z.literal("reuse"),
  from: boundedString(256),
});
const planSessionSchema = z.union([
  isolatedPlanSessionSchema,
  branchPlanSessionSchema,
  reusePlanSessionSchema,
]);

const planNodeShapeSchema = strictRecord({
  planNodeId: boundedString(256),
  type: z.enum([
    "task",
    "workflow",
    "validation.check",
    "validation.gate",
    "repeat",
    "choice",
  ]),
  label: boundedString(512),
  taskId: boundedString(256).optional(),
  session: planSessionSchema.optional(),
  dependsOn: arrayOf(nonEmptyStringSchema, { maximum: 10_000 }),
  parentPlanNodeId: boundedString(256).optional(),
  siblingOrder: nonNegativeIntegerSchema,
  maximumIterations: positiveIntegerSchema.optional(),
});
const planNodeSchema = planNodeShapeSchema.pipe(
  z.custom<z.output<typeof planNodeShapeSchema>>((value) => {
    const result = planNodeShapeSchema.safeParse(value);
    return (
      result.success &&
      (result.data.type === "repeat" ||
        result.data.maximumIterations === undefined) &&
      (result.data.type === "task" || result.data.session === undefined)
    );
  }),
);

const workflowIdentitySchema = strictRecord({
  id: boundedString(256),
  version: boundedString(128).optional(),
});

const planSnapshotShapeSchema = strictRecord({
  workflow: workflowIdentitySchema,
  nodes: arrayOf(planNodeSchema, { maximum: 10_000 }),
});
export const seqlanePlanSnapshotSchema = planSnapshotShapeSchema.pipe(
  z.custom<z.output<typeof planSnapshotShapeSchema>>((value) => {
    const result = planSnapshotShapeSchema.safeParse(value);
    if (!result.success) return false;
    const snapshot = result.data;
    const nodeIds = new Set<string>();
    for (const node of snapshot.nodes) {
      if (nodeIds.has(node.planNodeId)) return false;
      nodeIds.add(node.planNodeId);
    }

    for (const node of snapshot.nodes) {
      if (
        node.dependsOn.some(
          (dependencyId) =>
            dependencyId === node.planNodeId || !nodeIds.has(dependencyId),
        ) ||
        new Set(node.dependsOn).size !== node.dependsOn.length
      ) {
        return false;
      }
      if (
        node.session?.type !== undefined &&
        node.session.type !== "isolated" &&
        (!nodeIds.has(node.session.from) ||
          !node.dependsOn.includes(node.session.from))
      ) {
        return false;
      }
      if (
        node.parentPlanNodeId !== undefined &&
        (node.parentPlanNodeId === node.planNodeId ||
          !nodeIds.has(node.parentPlanNodeId))
      ) {
        return false;
      }
    }

    return true;
  }),
);

const iterationSchema = positiveIntegerSchema;

function eventSchema<TType extends string, TShape extends z.ZodRawShape>(
  type: TType,
  shape: TShape,
) {
  return strictRecord({
    type: z.literal(type),
    ...shape,
    metadata: metadataSchema,
  });
}

const runStartedSchema = eventSchema("run.started", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
});

const runPlanSchema = eventSchema("run.plan", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  plan: seqlanePlanSnapshotSchema,
});

const runHeartbeatSchema = eventSchema("run.heartbeat", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  activeInvocationIds: arrayOf(nonEmptyStringSchema),
  elapsedMs: nonNegativeNumberSchema,
});

const invocationCreatedShapeSchema = eventSchema("invocation.created", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  planNodeId: nonEmptyStringSchema,
  subject: subjectSchema,
  taskId: nonEmptyStringSchema.optional(),
  kind: z.enum(["workflow", "loop", "choice", "task", "validation"]),
  label: nonEmptyStringSchema,
  parentInvocationId: nonEmptyStringSchema.optional(),
  iteration: iterationSchema.optional(),
  siblingOrder: nonNegativeIntegerSchema,
  dependencyIds: arrayOf(nonEmptyStringSchema),
});
const invocationCreatedSchema = invocationCreatedShapeSchema.pipe(
  z.custom<z.output<typeof invocationCreatedShapeSchema>>((value) => {
    const result = invocationCreatedShapeSchema.safeParse(value);
    if (!result.success) return false;
    if (result.data.taskId === undefined) return true;
    return (
      result.data.subject.type === "task" &&
      result.data.taskId === result.data.subject.taskId
    );
  }),
);

const invocationStartedShapeSchema = eventSchema("invocation.started", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  subject: subjectSchema,
  taskId: nonEmptyStringSchema.optional(),
  iteration: iterationSchema.optional(),
});
const invocationStartedSchema = invocationStartedShapeSchema.pipe(
  z.custom<z.output<typeof invocationStartedShapeSchema>>((value) => {
    const result = invocationStartedShapeSchema.safeParse(value);
    if (!result.success) return false;
    if (result.data.taskId === undefined) return true;
    return (
      result.data.subject.type === "task" &&
      result.data.taskId === result.data.subject.taskId
    );
  }),
);

const invocationProgressSchema = eventSchema("invocation.progress", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  state: z.enum(["active", "waiting"]),
  phase: nonEmptyStringSchema,
  message: z.string().optional(),
  label: nonEmptyStringSchema.optional(),
  waitingReason: nonEmptyStringSchema.optional(),
  workspace: z.enum(["shared", "exclusive"]).optional(),
  blockingInvocationId: nonEmptyStringSchema.optional(),
  dependencyIds: arrayOf(nonEmptyStringSchema).optional(),
  iteration: iterationSchema.optional(),
});

const invocationOutputSchema = eventSchema("invocation.output", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  policy: z.enum(["transient", "persistent"]),
  channel: z.enum(["task", "run"]),
  content: z.string(),
  metrics: metricsSchema.optional(),
  summary: outputSummarySchema.optional(),
  iteration: iterationSchema.optional(),
});

const invocationActivitySchema = eventSchema("invocation.activity", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  activityId: nonEmptyStringSchema,
  kind: z.enum(["tool", "skill"]),
  name: boundedString(256),
  state: z.enum(["started", "progress", "succeeded", "failed"]),
  input: displayValueSchema.optional(),
  output: displayValueSchema.optional(),
  activityMetadata: displayValueSchema.optional(),
  startedAt: nonNegativeNumberSchema.optional(),
  endedAt: nonNegativeNumberSchema.optional(),
  message: z.string().max(2_000).optional(),
  iteration: iterationSchema.optional(),
});

const observationStateSchema = z.enum([
  "started",
  "updated",
  "succeeded",
  "failed",
  "cancelled",
]);

const observationAvailabilitySchema = strictRecord({
  path: nonEmptyStringSchema,
  reason: z.enum([
    "source-unavailable",
    "not-json-representable",
    "projection-failed",
  ]),
});

const modelObservationSchema = strictRecord({
  operation: nonEmptyStringSchema.optional(),
  provider: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema.optional(),
  responseId: nonEmptyStringSchema.optional(),
  finishReasons: arrayOf(nonEmptyStringSchema).optional(),
  request: jsonValueSchema.optional(),
  response: jsonValueSchema.optional(),
  usage: jsonValueSchema.optional(),
  cost: nonNegativeNumberSchema.optional(),
  startedAt: nonNegativeNumberSchema.optional(),
  endedAt: nonNegativeNumberSchema.optional(),
  error: z.string().optional(),
});

const invocationObservationSchema = eventSchema("invocation.observation", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  observationId: nonEmptyStringSchema,
  parentObservationId: nonEmptyStringSchema.optional(),
  kind: z.literal("model"),
  state: observationStateSchema,
  attemptIndex: nonNegativeIntegerSchema.optional(),
  model: modelObservationSchema,
  availability: arrayOf(observationAvailabilitySchema).optional(),
  iteration: iterationSchema.optional(),
});

const invocationInputSchema = eventSchema("invocation.input", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  input: displayValueSchema,
  iteration: iterationSchema.optional(),
});

const invocationResultSchema = eventSchema("invocation.result", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  result: displayValueSchema,
  iteration: iterationSchema.optional(),
});

const invocationRetryingSchema = eventSchema("invocation.retrying", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  attempt: nonNegativeIntegerSchema,
  maximumAttempts: nonNegativeIntegerSchema.optional(),
  delayMs: nonNegativeIntegerSchema.optional(),
  nextAttemptAt: isoUtcTimestampSchema.optional(),
  lastError: serializedSeqlaneErrorSchema,
  iteration: iterationSchema.optional(),
});

const invocationSucceededSchema = eventSchema("invocation.succeeded", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  iteration: iterationSchema.optional(),
});

const invocationFailedSchema = eventSchema("invocation.failed", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  error: serializedSeqlaneErrorSchema,
  disposition: z.enum([
    "retry_scheduled",
    "fail_run",
    "continue_siblings",
    "skip_dependents",
    "cancelled_by_policy",
  ]),
  iteration: iterationSchema.optional(),
});

const invocationSkippedSchema = eventSchema("invocation.skipped", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  dependencyIds: arrayOf(nonEmptyStringSchema).optional(),
  iteration: iterationSchema.optional(),
});

const invocationCancelledSchema = eventSchema("invocation.cancelled", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
  reason: nonEmptyStringSchema.optional(),
  iteration: iterationSchema.optional(),
});

const runSucceededSchema = eventSchema("run.succeeded", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  output: jsonValueSchema,
});

const runFailedSchema = eventSchema("run.failed", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  error: serializedSeqlaneErrorSchema,
});

const runCancelledSchema = eventSchema("run.cancelled", {
  workId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
});

export const seqlaneExecutionEventSchema = z.union([
  runStartedSchema,
  runPlanSchema,
  runHeartbeatSchema,
  invocationCreatedSchema,
  invocationProgressSchema,
  invocationOutputSchema,
  invocationActivitySchema,
  invocationObservationSchema,
  invocationInputSchema,
  invocationResultSchema,
  invocationRetryingSchema,
  invocationStartedSchema,
  invocationSucceededSchema,
  invocationFailedSchema,
  invocationSkippedSchema,
  invocationCancelledSchema,
  runSucceededSchema,
  runFailedSchema,
  runCancelledSchema,
]);

type ReadonlyDeep<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly ReadonlyDeep<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: ReadonlyDeep<T[Key]> }
      : T;

export type ReadonlySchemaOutput<TSchema extends z.ZodType> = ReadonlyDeep<
  z.output<TSchema>
>;

export type SeqlaneExecutionEventMetadata = ReadonlySchemaOutput<
  typeof metadataSchema
>;
export type SerializedValidationFailure = ReadonlySchemaOutput<
  typeof serializedValidationFailureSchema
>;
export type SerializedSeqlaneError = ReadonlySchemaOutput<
  typeof serializedSeqlaneErrorSchema
>;
export type SeqlanePlanNodeSnapshot = ReadonlySchemaOutput<
  typeof planNodeSchema
>;
export type SeqlanePlanSnapshot = ReadonlySchemaOutput<
  typeof seqlanePlanSnapshotSchema
>;
export type SeqlaneExecutionEvent = ReadonlySchemaOutput<
  typeof seqlaneExecutionEventSchema
>;

type EventOf<TType extends SeqlaneExecutionEvent["type"]> = Extract<
  SeqlaneExecutionEvent,
  { type: TType }
>;

export type RunStartedEvent = EventOf<"run.started">;
export type RunPlanEvent = EventOf<"run.plan">;
export type InvocationCreatedEvent = EventOf<"invocation.created">;
export type InvocationProgressEvent = EventOf<"invocation.progress">;
export type InvocationOutputEvent = EventOf<"invocation.output">;
export type InvocationActivityEvent = EventOf<"invocation.activity">;
export type InvocationObservationEvent = EventOf<"invocation.observation">;
/** Canonical observation record emitted by an adapter before runtime envelope projection. */
export type SeqlaneObservation = Omit<
  InvocationObservationEvent,
  "type" | "metadata" | "workId" | "runId" | "invocationId" | "iteration"
>;
export type InvocationInputEvent = EventOf<"invocation.input">;
export type InvocationResultEvent = EventOf<"invocation.result">;
export type InvocationRetryingEvent = EventOf<"invocation.retrying">;
export type InvocationStartedEvent = EventOf<"invocation.started">;
export type InvocationSucceededEvent = EventOf<"invocation.succeeded">;
export type InvocationFailedEvent = EventOf<"invocation.failed">;
export type InvocationSkippedEvent = EventOf<"invocation.skipped">;
export type InvocationCancelledEvent = EventOf<"invocation.cancelled">;
export type RunHeartbeatEvent = EventOf<"run.heartbeat">;
export type RunSucceededEvent = EventOf<"run.succeeded">;
export type RunFailedEvent = EventOf<"run.failed">;
export type RunCancelledEvent = EventOf<"run.cancelled">;

/** Schema-backed compatibility guard for consumers of the protocol package. */
export function isValidationIssue(value: unknown): value is ValidationIssue {
  try {
    return validationIssueSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

export function isSeqlaneExecutionEvent(
  value: unknown,
): value is SeqlaneExecutionEvent {
  try {
    return seqlaneExecutionEventSchema.safeParse(value).success;
  } catch {
    return false;
  }
}
