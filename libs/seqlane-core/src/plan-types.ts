import type {
  PlanNodeId,
  TaskDefinitionRegistry,
  TaskId,
  ValidatorDefinitionRegistry,
  WorkspacePolicy,
  WorkflowDefinition,
} from "./contracts.js";
import type { ValueBinding, ValueRef } from "./bindings.js";

export interface WorkflowIdentity {
  readonly id: string;
  readonly version?: string;
}

export type PlanSessionPolicy =
  | { readonly type: "isolated" }
  | { readonly type: "reuse"; readonly from: PlanNodeId }
  | { readonly type: "branch"; readonly from: PlanNodeId };

export interface TaskNode {
  readonly type: "task";
  readonly taskId: TaskId;
  readonly nodeId: PlanNodeId;
  readonly workspace: WorkspacePolicy;
  /** Omitted legacy Plan nodes resolve to isolated at the runtime boundary. */
  readonly session?: PlanSessionPolicy;
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
  readonly nodes: readonly (TaskNode | ValidationNode)[];
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

export type PlanNode = TaskNode | ValidationNode | RepeatNode;

export interface Plan {
  readonly workflow: WorkflowIdentity;
  readonly nodes: readonly PlanNode[];
  readonly output: ValueBinding;
}

export interface BuiltWorkflow<Input = unknown, Output = unknown> {
  readonly workflow: WorkflowDefinition<Input, Output>;
  readonly plan: Plan;
  readonly taskDefinitions: TaskDefinitionRegistry;
  readonly validatorDefinitions: ValidatorDefinitionRegistry;
}
