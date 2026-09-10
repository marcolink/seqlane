import type {
  JsonValue,
  BuiltWorkflow,
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
  /** Present only when the workflow author supplied a typed definition. */
  readonly definition?: Pick<WorkflowDefinition, "input" | "output">;
  readonly plan: Plan;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly built: BuiltWorkflow;
}

const passthroughSchema = z.unknown();

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
  let built: BuiltWorkflow;

  const workflowDefinition = workflowDefinitionSchema.safeParse(exported);
  if (workflowDefinition.success) {
    const workflowBuilt = buildWorkflow(workflowDefinition.data);
    built = workflowBuilt;
    workflow = workflowDefinition.data;
    plan = workflowBuilt.plan;
    taskDefinitions = workflowBuilt.taskDefinitions;
    validatorDefinitions = workflowBuilt.validatorDefinitions;
  } else {
    const workflowFactory = workflowPlanFactorySchema.safeParse(exported);
    if (workflowFactory.success) {
      workflow = workflowFactory.data;
      plan = workflowFactory.data(input);
      built = {
        workflow: {
          id: reference.id,
          input: passthroughSchema,
          output: passthroughSchema,
          build: () => {
            throw new Error(
              "Legacy Plans cannot be rebuilt as workflow definitions",
            );
          },
        },
        plan,
        taskDefinitions: new Map(),
        validatorDefinitions: new Map(),
      };
    } else {
      const exportedPlan = planSchema.safeParse(exported);
      if (!exportedPlan.success) {
        throw new Error(
          `Workflow export "${describeReference(reference)}" must be a Plan or a Plan factory`,
        );
      }
      workflow = exportedPlan.data;
      plan = exportedPlan.data;
      built = {
        workflow: {
          id: reference.id,
          input: passthroughSchema,
          output: passthroughSchema,
          build: () => {
            throw new Error(
              "Legacy Plans cannot be rebuilt as workflow definitions",
            );
          },
        },
        plan,
        taskDefinitions: new Map(),
        validatorDefinitions: new Map(),
      };
    }
  }

  const loadedPlan = planSchema.safeParse(plan);
  if (!loadedPlan.success) {
    throw new Error(
      `Workflow export "${describeReference(reference)}" must be a Plan or a Plan factory`,
    );
  }
  plan = loadedPlan.data;

  validatePlan(plan, taskDefinitions);

  return {
    reference,
    workflow,
    ...(workflowDefinition.success
      ? { definition: workflowDefinition.data }
      : {}),
    plan,
    taskDefinitions,
    validatorDefinitions,
    built,
  };
}
