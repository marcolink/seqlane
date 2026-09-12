import { seqlanePlanSnapshotSchema } from "@seqlane/events";
import { z } from "zod";

const workflowScopeSchema = z.enum(["repository", "user"]);

export const workflowListRecordSchema = z.strictObject({
  name: z.string(),
  scope: workflowScopeSchema,
  qualifiedName: z.string(),
  moduleSpecifier: z.string(),
  exportName: z.string(),
  description: z.string(),
});

export const workflowListResultSchema = z.array(workflowListRecordSchema);

const planWorkflowSchema = z.strictObject({
  name: z.string(),
  scope: z.enum(["repository", "user", "direct"]),
  qualifiedName: z.string(),
  moduleSpecifier: z.string(),
  exportName: z.string(),
  description: z.string().optional(),
});

export const planCommandResultSchema = z.strictObject({
  workflow: planWorkflowSchema,
  plan: seqlanePlanSnapshotSchema,
});

export type WorkflowListRecord = z.output<typeof workflowListRecordSchema>;
export type PlanCommandResult = z.output<typeof planCommandResultSchema>;
