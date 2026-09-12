import type { InputBinding } from "./bindings.js";
import type { AuthoredWorkflow, WorkflowDefinition } from "./contracts.js";
import type { WorkflowBuildContext } from "./workflow-authoring-internal.js";

export type WorkflowPlanBuilder<Input, Output> = (
  context: WorkflowBuildContext<Input>,
) => InputBinding<Output>;

const workflowPlanBuilderSymbol = Symbol.for("seqlane.workflowPlanBuilder");
const authoredWorkflowBrandSymbol = Symbol.for("seqlane.authoredWorkflow");

export function registerWorkflowPlanBuilder<Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
  builder: WorkflowPlanBuilder<Input, Output>,
): AuthoredWorkflow<Input, Output> {
  Object.defineProperty(workflow, workflowPlanBuilderSymbol, {
    configurable: false,
    enumerable: false,
    value: builder,
    writable: false,
  });
  Object.defineProperty(workflow, authoredWorkflowBrandSymbol, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return workflow as AuthoredWorkflow<Input, Output>;
}

export function getWorkflowPlanBuilder<Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
): WorkflowPlanBuilder<Input, Output> | undefined {
  const builder = Object.getOwnPropertyDescriptor(
    workflow,
    workflowPlanBuilderSymbol,
  )?.value;
  return typeof builder === "function"
    ? (builder as WorkflowPlanBuilder<Input, Output>)
    : undefined;
}

export function isAuthoredWorkflow(
  value: unknown,
): value is AuthoredWorkflow<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as object;
  return (
    Object.getOwnPropertyDescriptor(candidate, authoredWorkflowBrandSymbol)
      ?.value === true &&
    typeof Object.getOwnPropertyDescriptor(candidate, workflowPlanBuilderSymbol)
      ?.value === "function"
  );
}
