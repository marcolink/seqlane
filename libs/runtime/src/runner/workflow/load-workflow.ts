import type {
  JsonValue,
  BuiltWorkflow,
  Plan,
  SeqlaneSchema,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
  WorkflowDefinition,
  AuthoredWorkflow,
} from "@seqlane/core";
import type { WorkflowReference } from "@seqlane/protocol";
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

/** An authored definition loaded for a standalone execution entrypoint. */
export interface LoadedAuthoredWorkflow {
  readonly reference: WorkflowReference;
  readonly definition: AuthoredWorkflow;
  readonly plan: Plan;
  readonly taskDefinitions: TaskDefinitionRegistry;
  readonly validatorDefinitions: ValidatorDefinitionRegistry;
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

export function buildAuthoredWorkflow(
  reference: WorkflowReference,
  exported: unknown,
): LoadedAuthoredWorkflow | undefined {
  const workflowDefinition = workflowDefinitionSchema.safeParse(exported);
  if (
    !workflowDefinition.success ||
    !isAuthoredWorkflow(workflowDefinition.data)
  ) {
    return undefined;
  }

  const definition = workflowDefinition.data as AuthoredWorkflow;
  const built = buildWorkflow(definition);
  validateParsedPlan(
    built.plan,
    built.taskDefinitions,
    true,
    built.workflowDefinitions,
  );
  return {
    reference,
    definition,
    plan: built.plan,
    taskDefinitions: built.taskDefinitions,
    validatorDefinitions: built.validatorDefinitions,
    built,
  };
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

  const authored = buildAuthoredWorkflow(reference, exported);
  if (authored !== undefined) {
    built = authored.built;
    workflow = authored.definition;
    plan = authored.plan;
    taskDefinitions = authored.taskDefinitions;
    validatorDefinitions = authored.validatorDefinitions;
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
        workflowDefinitions: new Map(),
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
        workflowDefinitions: new Map(),
      };
    }
  }

  validateParsedPlan(
    plan,
    taskDefinitions,
    taskDefinitions !== undefined || built.workflowDefinitions.size > 0,
    built.workflowDefinitions,
  );

  return {
    reference,
    workflow,
    ...(authored === undefined ? {} : { definition: authored.definition }),
    plan,
    taskDefinitions,
    validatorDefinitions,
    built,
  };
}
