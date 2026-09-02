import type {
  JsonValue,
  Plan,
  SeqlaneSchema,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
  WorkflowDefinition,
  WorkflowReference,
} from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import { validatePlan } from "../../runtime/validation/plan-validation.js";
import { z } from "zod";

const planShapeSchema = z.looseObject({
  workflow: z.looseObject({ id: z.string() }),
  nodes: z.array(z.unknown()),
  output: z.unknown(),
});

const planSchema = z.custom<Plan>(
  (value) =>
    planShapeSchema.safeParse(value).success &&
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "output"),
);

const seqlaneSchemaShapeSchema = z.looseObject({
  parse: z.custom<SeqlaneSchema["parse"]>(
    (value) => typeof value === "function",
  ),
});

const workflowDefinitionShapeSchema = z.looseObject({
  id: z.string(),
  input: seqlaneSchemaShapeSchema,
  output: seqlaneSchemaShapeSchema,
  build: z.custom<WorkflowDefinition["build"]>(
    (value) => typeof value === "function",
  ),
});

const workflowDefinitionSchema = z.custom<WorkflowDefinition>(
  (value) => workflowDefinitionShapeSchema.safeParse(value).success,
);

const workflowPlanFactorySchema = z.custom<(input: JsonValue) => Plan>(
  (value) => typeof value === "function",
);

export type WorkflowPlanFactory = z.output<typeof workflowPlanFactorySchema>;

export interface LoadedWorkflow {
  readonly reference: WorkflowReference;
  readonly workflow: Plan | WorkflowPlanFactory | WorkflowDefinition;
  readonly plan: Plan;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
}

function describeReference(reference: WorkflowReference): string {
  return `${reference.moduleSpecifier}#${reference.exportName}`;
}

export async function loadWorkflow(
  reference: WorkflowReference,
  input: JsonValue,
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

  const exported = module[reference.exportName];
  let plan: Plan;
  let workflow: Plan | WorkflowPlanFactory | WorkflowDefinition;
  let taskDefinitions: TaskDefinitionRegistry | undefined;
  let validatorDefinitions: ValidatorDefinitionRegistry | undefined;

  const workflowDefinition = workflowDefinitionSchema.safeParse(exported);
  if (workflowDefinition.success) {
    const built = buildWorkflow(workflowDefinition.data);
    workflow = workflowDefinition.data;
    plan = built.plan;
    taskDefinitions = built.taskDefinitions;
    validatorDefinitions = built.validatorDefinitions;
  } else {
    const workflowFactory = workflowPlanFactorySchema.safeParse(exported);
    if (workflowFactory.success) {
      workflow = workflowFactory.data;
      plan = workflowFactory.data(input);
    } else {
      const exportedPlan = planSchema.safeParse(exported);
      if (!exportedPlan.success) {
        throw new Error(
          `Workflow export "${describeReference(reference)}" must be a Plan or a Plan factory`,
        );
      }
      workflow = exportedPlan.data;
      plan = exportedPlan.data;
    }
  }

  const loadedPlan = planSchema.safeParse(plan);
  if (!loadedPlan.success) {
    throw new Error(
      `Workflow export "${describeReference(reference)}" must be a Plan or a Plan factory`,
    );
  }
  plan = loadedPlan.data;

  validatePlan(plan);

  return {
    reference,
    workflow,
    plan,
    taskDefinitions,
    validatorDefinitions,
  };
}
