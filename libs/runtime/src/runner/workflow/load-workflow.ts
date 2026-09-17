import type { BuiltWorkflow, AuthoredWorkflow } from "@seqlane/core";
import type { WorkflowReference } from "@seqlane/protocol";
import { buildWorkflow, isAuthoredWorkflow } from "@seqlane/core";
import { validateParsedPlan } from "../../runtime/validation/plan-validation.js";
export type LoadedWorkflow = Omit<BuiltWorkflow, "workflow"> & {
  readonly reference: WorkflowReference;
  readonly workflow: AuthoredWorkflow;
};

function describeReference(reference: WorkflowReference): string {
  return `${reference.moduleSpecifier}#${reference.exportName}`;
}

export function compileWorkflowExport(
  reference: WorkflowReference,
  exported: unknown,
): LoadedWorkflow {
  if (!isAuthoredWorkflow(exported)) {
    throw new Error(
      `Workflow export "${describeReference(reference)}" must be an authored Seqlane workflow definition`,
    );
  }

  const built = buildWorkflow(exported);
  validateParsedPlan(
    built.plan,
    built.taskDefinitions,
    true,
    built.workflowDefinitions,
  );
  return {
    ...built,
    reference,
    workflow: exported,
  };
}

export async function loadWorkflow(
  reference: WorkflowReference,
): Promise<LoadedWorkflow> {
  const module = (await import(reference.moduleSpecifier)) as Record<
    string,
    unknown
  >;

  if (!Object.hasOwn(module, reference.exportName)) {
    throw new Error(
      `Workflow module "${describeReference(reference)}" does not export "${reference.exportName}"`,
    );
  }

  return compileWorkflowExport(reference, module[reference.exportName]);
}
