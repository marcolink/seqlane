import type { InputBinding } from "./bindings.js";
import type { WorkflowBuildContext, WorkflowDefinition } from "./contracts.js";

export type WorkflowPlanBuilder<Input, Output> = (
  context: WorkflowBuildContext<Input>,
) => InputBinding<Output>;

const workflowPlanBuilderSymbol = Symbol.for("seqlane.workflowPlanBuilder");

export function registerWorkflowPlanBuilder<Input, Output>(
  workflow: WorkflowDefinition<Input, Output>,
  builder: WorkflowPlanBuilder<Input, Output>,
): void {
  Object.defineProperty(workflow, workflowPlanBuilderSymbol, {
    configurable: false,
    enumerable: false,
    value: builder,
    writable: false,
  });
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
