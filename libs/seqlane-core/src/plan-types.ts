import type {
  PlanNodeId,
  TaskDefinitionRegistry,
  TaskId,
  ValidatorDefinitionRegistry,
  WorkspacePolicy,
  WorkflowDefinition,
} from "./contracts.js";
import type { ValueBinding, ValueRef } from "./bindings.js";
import { valueBindingSchema, valueRefSchema } from "./bindings.js";
import type { ModelSelection } from "./models/model-ref.js";
import { modelSelectionSchema } from "./models/model-ref.js";
import { z } from "zod";

export interface WorkflowIdentity {
  readonly id: string;
  readonly version?: string;
}

/** Maximum number of repeat-body executions admitted in one run. */
export const MAX_REPEAT_BODY_EXECUTIONS = 1_000;

export type PlanSessionPolicy =
  | { readonly type: "isolated"; readonly model?: ModelSelection }
  | { readonly type: "reuse"; readonly from: PlanNodeId }
  | {
      readonly type: "branch";
      readonly from: PlanNodeId;
      readonly model?: ModelSelection;
    };

export const planSessionPolicySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("isolated"),
    model: modelSelectionSchema.optional(),
  }),
  z.strictObject({ type: z.literal("reuse"), from: z.string().min(1) }),
  z.strictObject({
    type: z.literal("branch"),
    from: z.string().min(1),
    model: modelSelectionSchema.optional(),
  }),
]);

export interface TaskNode {
  readonly type: "task";
  readonly taskId: TaskId;
  readonly nodeId: PlanNodeId;
  readonly workspace: WorkspacePolicy;
  readonly session?: PlanSessionPolicy;
  readonly input: ValueBinding;
  readonly dependsOn: readonly PlanNodeId[];
}

export interface WorkflowNode {
  readonly type: "workflow";
  readonly workflowId: string;
  readonly nodeId: PlanNodeId;
  readonly workspace: WorkspacePolicy;
  readonly input: ValueBinding;
  readonly dependsOn: readonly PlanNodeId[];
}

export type ValidationSource =
  | { readonly type: "mechanical"; readonly validatorId: string }
  | {
      readonly type: "task";
      readonly taskId: TaskId;
      readonly workspace: WorkspacePolicy;
    };

export interface ValidationCheckNode {
  readonly type: "validation.check";
  readonly nodeId: PlanNodeId;
  readonly source: ValidationSource;
  readonly input: ValueBinding;
  readonly dependsOn: readonly PlanNodeId[];
}

export type ValidationGatePolicy = "fail" | "repeat-postcondition";

export interface ValidationGateNode {
  readonly type: "validation.gate";
  readonly nodeId: PlanNodeId;
  readonly input: ValueBinding;
  readonly checkNodeId: PlanNodeId;
  readonly policy: ValidationGatePolicy;
  readonly dependsOn: readonly PlanNodeId[];
}

export type ValidationNode = ValidationCheckNode | ValidationGateNode;

export interface RepeatBodyPlan {
  readonly inputNodeId: PlanNodeId;
  readonly nodes: readonly (TaskNode | WorkflowNode | ValidationNode)[];
  readonly output: ValueBinding;
  readonly until: ValueRef<boolean>;
}

export interface RepeatNode {
  readonly type: "repeat";
  readonly nodeId: PlanNodeId;
  readonly input: ValueBinding;
  readonly dependsOn: readonly PlanNodeId[];
  readonly maximumIterations: number;
  readonly body: RepeatBodyPlan;
}

export type PlanNode = TaskNode | WorkflowNode | ValidationNode | RepeatNode;

export interface Plan {
  readonly workflow: WorkflowIdentity;
  readonly nodes: readonly PlanNode[];
  readonly output: ValueBinding;
}

export const planNodeIdSchema = z.string().min(1);
const dependencySchema = z.array(planNodeIdSchema);

export const taskNodeSchema = z.strictObject({
  type: z.literal("task"),
  taskId: z.string().min(1),
  nodeId: planNodeIdSchema,
  workspace: z.enum(["shared", "exclusive"]),
  session: planSessionPolicySchema.optional(),
  input: valueBindingSchema,
  dependsOn: dependencySchema,
});

export const workflowNodeSchema = z.strictObject({
  type: z.literal("workflow"),
  workflowId: z.string().min(1),
  nodeId: planNodeIdSchema,
  workspace: z.enum(["shared", "exclusive"]),
  input: valueBindingSchema,
  dependsOn: dependencySchema,
});

export const validationSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("mechanical"),
    validatorId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("task"),
    taskId: z.string().min(1),
    workspace: z.enum(["shared", "exclusive"]),
  }),
]);

export const validationCheckNodeSchema = z.strictObject({
  type: z.literal("validation.check"),
  nodeId: planNodeIdSchema,
  source: validationSourceSchema,
  input: valueBindingSchema,
  dependsOn: dependencySchema,
});

export const validationGateNodeSchema = z.strictObject({
  type: z.literal("validation.gate"),
  nodeId: planNodeIdSchema,
  input: valueBindingSchema,
  checkNodeId: planNodeIdSchema,
  policy: z.enum(["fail", "repeat-postcondition"]),
  dependsOn: dependencySchema,
});

export const validationNodeSchema = z.discriminatedUnion("type", [
  validationCheckNodeSchema,
  validationGateNodeSchema,
]);

const repeatBodyNodeSchema = z.discriminatedUnion("type", [
  taskNodeSchema,
  workflowNodeSchema,
  validationCheckNodeSchema,
  validationGateNodeSchema,
]);

export const repeatNodeSchema = z.strictObject({
  type: z.literal("repeat"),
  nodeId: planNodeIdSchema,
  input: valueBindingSchema,
  dependsOn: dependencySchema,
  maximumIterations: z
    .number()
    .int()
    .finite()
    .min(1)
    .max(MAX_REPEAT_BODY_EXECUTIONS),
  body: z.strictObject({
    inputNodeId: planNodeIdSchema,
    nodes: z.array(repeatBodyNodeSchema),
    output: valueBindingSchema,
    until: valueRefSchema,
  }),
});

export const planNodeSchema = z.discriminatedUnion("type", [
  taskNodeSchema,
  workflowNodeSchema,
  validationCheckNodeSchema,
  validationGateNodeSchema,
  repeatNodeSchema,
]);

export const planSchema = z.strictObject({
  workflow: z.strictObject({
    id: z.string().min(1),
    version: z.string().min(1).optional(),
  }),
  nodes: z.array(planNodeSchema),
  output: valueBindingSchema,
});

export type PlanSchemaOutput = z.infer<typeof planSchema>;

export interface BuiltWorkflow<Input = unknown, Output = unknown> {
  readonly workflow: WorkflowDefinition<Input, Output>;
  readonly plan: Plan;
  readonly taskDefinitions: TaskDefinitionRegistry;
  readonly validatorDefinitions: ValidatorDefinitionRegistry;
  /** Runtime-only registry for nested workflow definitions. */
  readonly workflowDefinitions: ReadonlyMap<
    string,
    BuiltWorkflow<unknown, unknown>
  >;
}
