import {
  taskDefinitionRegistrySchema,
  type Plan,
  type PlanNode,
  type TaskDefinitionRegistry,
  type WorkflowDefinitionRegistry,
} from "@seqlane/core";
import { orderParsedPlanNodes } from "../plan/plan-ordering.js";
import { validatePlan } from "../validation/plan-validation.js";

export interface PreparedPlan {
  readonly plan: Plan;
  readonly orderedNodes: readonly PlanNode[];
}

/** Validate and order Plan data without creating an execution program. */
export function preparePlan(
  plan: Plan,
  taskDefinitions?: TaskDefinitionRegistry,
  workflowDefinitions?: WorkflowDefinitionRegistry,
): PreparedPlan {
  if (taskDefinitions !== undefined) {
    taskDefinitionRegistrySchema.parse(taskDefinitions);
  }
  const parsedPlan = validatePlan(
    plan,
    taskDefinitions,
    taskDefinitions !== undefined || workflowDefinitions !== undefined,
    workflowDefinitions,
  );
  return { plan: parsedPlan, orderedNodes: orderParsedPlanNodes(parsedPlan) };
}

export function compilePlan(plan: Plan): PreparedPlan {
  return preparePlan(plan);
}
