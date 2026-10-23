import { jsonValueSchema } from "@seqlane/core";
import { z } from "zod";
import {
  seqlaneExecutionEventSchema,
  seqlanePlanSnapshotSchema,
  serializedSeqlaneErrorSchema,
} from "./validation.js";
import { runtimeProfileReferenceSchema } from "./runner-protocol.js";
import { telemetrySpanSnapshotSchema } from "./telemetry-span-snapshot.js";

const idSchema = z.string().min(1).max(256);
const sequenceSchema = z.number().safe().int().nonnegative();
const timestampSchema = z.iso.datetime({ precision: 3 });
const statusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const storageErrorSchema = serializedSeqlaneErrorSchema;

export const operationalHealthSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["ok", "degraded"]),
});

export const operationalReadinessSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["ready", "not_ready"]),
  checks: z.array(
    z.strictObject({
      id: idSchema,
      status: z.enum(["ready", "not_ready"]),
      detail: z.string().max(1024).optional(),
    }),
  ),
});

const workflowIoDescriptionSchema = z.strictObject({
  schema: jsonValueSchema,
  description: z.string().max(4096).optional(),
});

export const operationalWorkflowSchema = z.strictObject({
  id: idSchema,
  key: idSchema,
  input: workflowIoDescriptionSchema,
  output: workflowIoDescriptionSchema,
  plan: seqlanePlanSnapshotSchema,
});

export const operationalWorkflowListSchema = z.strictObject({
  version: z.literal(1),
  workflows: z.array(operationalWorkflowSchema),
});

export const operationalWorkflowDetailSchema = z.strictObject({
  version: z.literal(1),
  workflow: operationalWorkflowSchema,
});

export const operationalRunStartRequestSchema = z.strictObject({
  version: z.literal(1),
  workId: idSchema.optional(),
  runId: idSchema.optional(),
  input: jsonValueSchema,
  runtime: runtimeProfileReferenceSchema.optional(),
});

export const operationalRunReferenceSchema = z.strictObject({
  version: z.literal(1),
  workId: idSchema,
  runId: idSchema,
  status: z.literal("queued"),
});

export const operationalRunCompletenessSchema = z
  .strictObject({
    inspection: z.enum(["complete", "incomplete"]),
    storageError: storageErrorSchema.optional(),
  })
  .superRefine((completeness, context) => {
    if (
      completeness.storageError !== undefined &&
      completeness.inspection === "complete"
    ) {
      context.addIssue({
        code: "custom",
        path: ["storageError"],
        message: "Storage errors require incomplete inspection",
      });
    }
  });

export const operationalRunSummarySchema = z.strictObject({
  workId: idSchema,
  runId: idSchema,
  workflowKey: idSchema,
  status: statusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const operationalRunStatusSchema = operationalRunSummarySchema
  .extend({
    version: z.literal(1),
    output: jsonValueSchema.optional(),
    error: serializedSeqlaneErrorSchema.optional(),
    completeness: operationalRunCompletenessSchema,
  })
  .superRefine((status, context) => {
    if (
      (status.status === "queued" || status.status === "running") &&
      status.completeness.inspection === "complete"
    ) {
      context.addIssue({
        code: "custom",
        path: ["completeness", "inspection"],
        message: "Active runs cannot have complete inspection",
      });
    }
  });

export const operationalRunListRequestSchema = z.strictObject({
  version: z.literal(1),
  limit: z.number().safe().int().min(1).max(100).default(50),
  cursor: sequenceSchema.optional(),
});

export const operationalRunListSchema = z.strictObject({
  version: z.literal(1),
  runs: z.array(operationalRunSummarySchema).max(100),
  nextCursor: sequenceSchema.optional(),
});

const sequencedEventSchema = z
  .strictObject({
    sequence: sequenceSchema,
    event: seqlaneExecutionEventSchema,
  })
  .refine((item) => item.sequence === item.event.metadata.sequence, {
    message: "Event sequence must match canonical event metadata",
  });

export const operationalRunEventsRequestSchema = z.strictObject({
  version: z.literal(1),
  afterSequence: sequenceSchema.default(0),
  limit: z.number().safe().int().min(1).max(1000).default(100),
});

export const operationalRunEventsSchema = z
  .strictObject({
    version: z.literal(1),
    runId: idSchema,
    afterSequence: sequenceSchema,
    events: z.array(sequencedEventSchema).max(1000),
    nextSequence: sequenceSchema,
    gap: z
      .strictObject({
        fromSequence: sequenceSchema,
        toSequence: sequenceSchema,
      })
      .optional(),
    status: statusSchema,
    completeness: operationalRunCompletenessSchema,
    terminalEvent: seqlaneExecutionEventSchema.optional(),
  })
  .superRefine((response, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const sequences = new Set<number>();
    const eventIds = new Set<string>();
    let expectedSequence = response.afterSequence + 1;
    let observedGap: { fromSequence: number; toSequence: number } | undefined;

    for (const [index, item] of response.events.entries()) {
      if (item.sequence <= response.afterSequence) {
        issue(
          ["events", index, "sequence"],
          "Event sequence must follow the cursor",
        );
      }
      if (sequences.has(item.sequence)) {
        issue(["events", index, "sequence"], "Event sequences must be unique");
      }
      sequences.add(item.sequence);
      if (item.sequence < expectedSequence) {
        issue(
          ["events", index, "sequence"],
          "Events must be in ascending sequence order",
        );
      } else if (item.sequence > expectedSequence) {
        const gap = response.gap;
        if (gap === undefined) {
          issue(
            ["events", index, "sequence"],
            "Missing event sequences require a covering gap",
          );
        } else if (
          gap.fromSequence !== expectedSequence ||
          gap.toSequence !== item.sequence - 1
        ) {
          issue(
            ["events", index, "sequence"],
            "Gap must match the missing event range",
          );
        }
        if (observedGap !== undefined) {
          issue(["gap"], "A page can report only one missing event range");
        }
        observedGap = {
          fromSequence: expectedSequence,
          toSequence: item.sequence - 1,
        };
      }
      expectedSequence = item.sequence + 1;

      if (item.event.runId !== response.runId) {
        issue(
          ["events", index, "event", "runId"],
          "Event run ID must match the response",
        );
      }
      const eventId = item.event.metadata.eventId;
      if (eventIds.has(eventId)) {
        issue(
          ["events", index, "event", "metadata", "eventId"],
          "Event IDs must be unique",
        );
      }
      eventIds.add(eventId);
    }

    if (
      response.nextSequence !==
      (response.events.at(-1)?.sequence ?? response.afterSequence)
    ) {
      issue(
        ["nextSequence"],
        "Next sequence must match the last returned event or cursor",
      );
    }

    const gap = response.gap;
    if (gap !== undefined) {
      if (
        gap.fromSequence === 0 ||
        gap.toSequence === 0 ||
        gap.fromSequence > gap.toSequence
      ) {
        issue(["gap"], "Gap sequences must be positive and ordered");
      }
      if (gap.fromSequence <= response.afterSequence) {
        issue(["gap", "fromSequence"], "Gap must follow the event cursor");
      }
      if (
        response.events.some(
          ({ sequence }) =>
            sequence >= gap.fromSequence && sequence <= gap.toSequence,
        )
      ) {
        issue(["gap"], "Gap must not overlap returned events");
      }
      const trailingGap = {
        fromSequence: expectedSequence,
        toSequence: gap.toSequence,
      };
      if (observedGap !== undefined) {
        if (
          gap.fromSequence !== observedGap.fromSequence ||
          gap.toSequence !== observedGap.toSequence
        ) {
          issue(["gap"], "Gap must match the single missing event range");
        }
      } else if (
        gap.fromSequence !== trailingGap.fromSequence ||
        gap.toSequence < trailingGap.fromSequence
      ) {
        issue(["gap"], "Gap must be adjacent to the returned event page");
      }
      if (response.completeness.inspection === "complete")
        issue(
          ["completeness", "inspection"],
          "Gaps require incomplete inspection",
        );
    }

    if (
      (response.status === "queued" || response.status === "running") &&
      response.completeness.inspection === "complete"
    ) {
      issue(
        ["completeness", "inspection"],
        "Active runs cannot have complete inspection",
      );
    }
    if (response.terminalEvent !== undefined) {
      const terminal = response.terminalEvent;
      const expectedTerminalType =
        response.status === "succeeded"
          ? "run.succeeded"
          : response.status === "failed"
            ? "run.failed"
            : response.status === "cancelled"
              ? "run.cancelled"
              : undefined;
      if (
        expectedTerminalType === undefined ||
        terminal.type !== expectedTerminalType
      ) {
        issue(
          ["terminalEvent", "type"],
          "Terminal event must match a terminal run status",
        );
      }
      if (terminal.runId !== response.runId) {
        issue(
          ["terminalEvent", "runId"],
          "Terminal event run ID must match the response",
        );
      }
    }
  });

export const operationalRunCancelRequestSchema = z.strictObject({
  version: z.literal(1),
  runId: idSchema,
});

export const operationalRunCancelSchema = z.strictObject({
  version: z.literal(1),
  runId: idSchema,
  status: statusSchema,
  cancellationRequested: z.boolean(),
});

export const operationalTraceInspectionSchema = z.strictObject({
  version: z.literal(1),
  runId: idSchema,
  traceId: z
    .string()
    .regex(/^(?!0{32})[0-9a-f]{32}$/)
    .optional(),
  spans: z.array(telemetrySpanSnapshotSchema).max(2000),
  droppedRecords: z.number().safe().int().nonnegative().default(0),
  completeness: operationalRunCompletenessSchema,
});

export type OperationalHealth = z.output<typeof operationalHealthSchema>;
export type OperationalReadiness = z.output<typeof operationalReadinessSchema>;
export type OperationalWorkflow = z.output<typeof operationalWorkflowSchema>;
export type OperationalWorkflowList = z.output<
  typeof operationalWorkflowListSchema
>;
export type OperationalWorkflowDetail = z.output<
  typeof operationalWorkflowDetailSchema
>;
export type OperationalRunStartRequest = z.output<
  typeof operationalRunStartRequestSchema
>;
export type OperationalRunReference = z.output<
  typeof operationalRunReferenceSchema
>;
export type OperationalRunCompleteness = z.output<
  typeof operationalRunCompletenessSchema
>;
export type OperationalRunSummary = z.output<
  typeof operationalRunSummarySchema
>;
export type OperationalRunStatus = z.output<typeof operationalRunStatusSchema>;
export type OperationalRunListRequest = z.output<
  typeof operationalRunListRequestSchema
>;
export type OperationalRunList = z.output<typeof operationalRunListSchema>;
export type OperationalRunEventsRequest = z.output<
  typeof operationalRunEventsRequestSchema
>;
export type OperationalRunEvents = z.output<typeof operationalRunEventsSchema>;
export type OperationalRunCancelRequest = z.output<
  typeof operationalRunCancelRequestSchema
>;
export type OperationalRunCancel = z.output<typeof operationalRunCancelSchema>;
export type OperationalTraceInspection = z.output<
  typeof operationalTraceInspectionSchema
>;
