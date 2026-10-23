import type { BuiltWorkflow } from "@seqlane/core";
import { z } from "zod";
import { validateParsedPlan } from "../validation/plan-validation.js";
import { createSeqlanePlanSnapshot } from "../../runner/workflow/plan-snapshot.js";
import type {
  OperationalWorkflowRegistration,
  OperationalWorkflowSource,
} from "./types.js";

/** Keeps workflow registration lightweight; no host, database, or HTTP module is loaded. */
export function createOperationalWorkflow(
  source: OperationalWorkflowSource,
): OperationalWorkflowRegistration {
  const workflow = {
    id: source.plan.workflow.id,
    input: source.workflow?.input ?? z.unknown(),
    output: source.workflow?.output ?? z.unknown(),
  };
  const workflowDefinitions = source.workflowDefinitions ?? new Map();
  validateParsedPlan(
    source.plan,
    source.taskDefinitions,
    source.taskDefinitions !== undefined,
    workflowDefinitions,
  );
  const built: BuiltWorkflow = {
    workflow,
    plan: source.plan,
    taskDefinitions: source.taskDefinitions ?? new Map(),
    validatorDefinitions: source.validatorDefinitions ?? new Map(),
    workflowDefinitions,
  };
  return {
    key: source.key,
    defaultRuntimeId: "local",
    source,
    workflow: built,
    planSnapshot: createSeqlanePlanSnapshot(source.plan),
  };
}
