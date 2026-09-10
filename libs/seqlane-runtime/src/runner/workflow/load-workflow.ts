import type {
  JsonValue,
  BuiltWorkflow,
  Plan,
  SeqlaneSchema,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
  WorkflowDefinition,
  AuthoredWorkflow,
  WorkflowReference,
} from "@seqlane/core";
import { buildWorkflow, isAuthoredWorkflow, planSchema } from "@seqlane/core";
import { validateParsedPlan } from "../../runtime/validation/plan-validation.js";
import { z } from "zod";

const seqlaneSchemaShapeSchema = z.looseObject({
  parse: z.custom<SeqlaneSchema["parse"]>(
    (value) => typeof value === "function",
  ),
});

const workflowDefinitionShapeSchema = z.looseObject({
  id: z.string(),
  input: seqlaneSchemaShapeSchema,
  output: seqlaneSchemaShapeSchema,
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

function parsePlan(value: unknown): Plan | undefined {
  const parsed = planSchema.safeParse(value);
  return parsed.success ? (parsed.data as Plan) : undefined;
}

function requirePlan(value: unknown, reference: WorkflowReference): Plan {
  const parsed = parsePlan(value);
  if (parsed === undefined) {
    throw new Error(
      `Workflow export "${describeReference(reference)}" must be a valid Plan or Plan factory result`,
    );
  }
  return parsed;
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
  if (
    workflowDefinition.success &&
    isAuthoredWorkflow(workflowDefinition.data)
  ) {
    const workflowBuilt = buildWorkflow(
      workflowDefinition.data as AuthoredWorkflow,
    );
    built = workflowBuilt;
    workflow = workflowDefinition.data;
    plan = workflowBuilt.plan;
    taskDefinitions = workflowBuilt.taskDefinitions;
    validatorDefinitions = workflowBuilt.validatorDefinitions;
  } else {
    const workflowFactory = workflowPlanFactorySchema.safeParse(exported);
    if (workflowFactory.success) {
      workflow = workflowFactory.data;
      plan = requirePlan(workflowFactory.data(input), reference);
      built = {
        workflow: {
          id: reference.id,
          input: passthroughSchema,
          output: passthroughSchema,
        },
        plan,
        taskDefinitions: new Map(),
        validatorDefinitions: new Map(),
      };
    } else {
      const exportedPlan = parsePlan(exported);
      if (exportedPlan === undefined) {
        throw new Error(
          `Workflow export "${describeReference(reference)}" must be a Plan or a Plan factory`,
        );
      }
      workflow = exportedPlan;
      plan = exportedPlan;
      built = {
        workflow: {
          id: reference.id,
          input: passthroughSchema,
          output: passthroughSchema,
        },
        plan,
        taskDefinitions: new Map(),
        validatorDefinitions: new Map(),
      };
    }
  }

  validateParsedPlan(plan, taskDefinitions);

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
