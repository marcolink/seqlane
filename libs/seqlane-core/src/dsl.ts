import type {
  CompletedFlow,
  CreateFlowOptions,
  FlowAuthoringContext,
  FlowBinding,
  FlowBuilder,
  FlowHandle,
  SessionPolicy,
  FlowValidationHandle,
  TaskDefinition,
  ValidatedRepeatCondition,
  Validator,
  ValidatorDefinition,
  WorkflowBuildContext,
  WorkflowDefinition,
} from "./contracts.js";
import { taskDefinitionSchema } from "./contracts.js";
import type { ModelSelection } from "./models/model-ref.js";
import type {
  InputBinding,
  SessionCheckpointRef,
  ValueRef,
} from "./bindings.js";
import { z } from "zod";

export function defineValidator<Input>(
  definition: ValidatorDefinition<Input>,
): ValidatorDefinition<Input> {
  return definition;
}

export function defineTask<Input, Output>(
  definition: TaskDefinition<Input, Output>,
): TaskDefinition<Input, Output> {
  taskDefinitionSchema.parse(definition);
  return definition;
}

interface AgentTaskFactoryInput<Input, Output> extends Omit<
  TaskDefinition<Input, Output>,
  "execute" | "goal"
> {
  readonly goal: (input: Input) => string;
  readonly instructions?: readonly string[];
  readonly references?: readonly string[];
}

export function defineAgentTask<Input, Output>(
  definition: AgentTaskFactoryInput<Input, Output>,
): TaskDefinition<Input, Output> {
  if (Object.hasOwn(definition, "execute")) {
    throw new TypeError("defineAgentTask does not accept execute");
  }
  const { goal, instructions, references, ...base } = definition;
  const task: TaskDefinition<Input, Output> = {
    ...base,
    execute: async ({ input, context }) =>
      context.runAgent({
        goal: goal(input),
        ...(instructions === undefined ? {} : { instructions }),
        ...(references === undefined ? {} : { references }),
      }) as Promise<Output>,
  };
  return defineTask(task);
}

export const shellTaskResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type ShellTaskResult = z.infer<typeof shellTaskResultSchema>;

interface ShellTaskFactoryInput<Input> extends Omit<
  TaskDefinition<Input, ShellTaskResult>,
  "execute" | "goal"
> {
  readonly executable: string;
  readonly argv: (input: Input) => readonly string[];
}

export function defineShellTask<Input>(
  definition: ShellTaskFactoryInput<Input>,
): TaskDefinition<Input, ShellTaskResult> {
  if (Object.hasOwn(definition, "execute")) {
    throw new TypeError("defineShellTask does not accept execute");
  }
  const { executable, argv, ...base } = definition;
  return defineTask({
    ...base,
    output: shellTaskResultSchema,
    execute: async ({ input, context }) =>
      context.exec({ executable, argv: argv(input) }),
  });
}

export function defineWorkflow<Input, Output>(
  definition: WorkflowDefinition<Input, Output>,
): WorkflowDefinition<Input, Output> {
  return definition;
}

export function validatedBy<State>(
  validator: Validator<State>,
): ValidatedRepeatCondition<State> {
  return { type: "validated", validator };
}

export function isolated(
  model?: ModelSelection,
): Extract<SessionPolicy, { readonly type: "isolated" }> {
  return model === undefined
    ? { type: "isolated" }
    : { type: "isolated", model };
}

export function reuse(from: SessionCheckpointRef): SessionPolicy {
  return { type: "reuse", from };
}

export function branch(
  from: SessionCheckpointRef,
  model?: ModelSelection,
): Extract<SessionPolicy, { readonly type: "branch" }> {
  return model === undefined
    ? { type: "branch", from }
    : { type: "branch", from, model };
}

type RuntimeFlowAuthoringContext<Input> = FlowAuthoringContext<
  Input,
  Record<string, FlowHandle>
>;

interface FlowDeclaration<Input> {
  readonly name: string;
  declare(
    context: WorkflowBuildContext<Input>,
    authoringContext: RuntimeFlowAuthoringContext<Input>,
  ): FlowHandle;
}

interface FlowRepeatDeclaration<Input> {
  readonly name: string;
  declare(
    context: WorkflowBuildContext<Input>,
    authoringContext: RuntimeFlowAuthoringContext<Input>,
  ): FlowHandle;
}

interface FlowValidationDeclaration<Input> {
  readonly name: string;
  declare(
    context: WorkflowBuildContext<Input>,
    authoringContext: RuntimeFlowAuthoringContext<Input>,
  ): FlowValidationHandle;
}

function resolveFlowDependencies<Input>(
  names: readonly string[] | undefined,
  authoringContext: RuntimeFlowAuthoringContext<Input>,
): readonly ValueRef[] | undefined {
  if (names === undefined) return undefined;

  return names.map((name) => {
    const dependency = authoringContext.tasks[name];
    if (dependency === undefined) {
      throw new Error(`Unknown Flow dependency "${name}"`);
    }
    return dependency.output;
  });
}

/**
 * Starts a typed Flow definition. Its declarations replay through the normal
 * WorkflowDefinition build callback, so Flow creates no second Plan format.
 */
export function createFlow<Input, Output>(
  options: CreateFlowOptions<Input, Output>,
): FlowBuilder<Input, Output, Record<never, never>> {
  const declarations: (
    | FlowDeclaration<Input>
    | FlowRepeatDeclaration<Input>
    | FlowValidationDeclaration<Input>
  )[] = [];
  let outputBinding: FlowBinding<Input, unknown, Output> | undefined;

  const completed: CompletedFlow<Input, Output> = {
    define: () =>
      defineWorkflow({
        ...options,
        build: (context) => {
          const authoringContext: RuntimeFlowAuthoringContext<Input> = {
            input: context.input,
            tasks: {},
          };
          for (const declaration of declarations) {
            authoringContext.tasks[declaration.name] = declaration.declare(
              context,
              authoringContext,
            );
          }
          if (outputBinding === undefined) {
            throw new Error("Flow output is not defined");
          }
          return typeof outputBinding === "function"
            ? (
                outputBinding as (
                  context: FlowAuthoringContext<Input, unknown>,
                ) => InputBinding<Output>
              )(authoringContext)
            : outputBinding;
        },
      }),
  };
  const builder: FlowBuilder<Input, Output, Record<never, never>> = {
    task: (name, definition, binding, taskOptions) => {
      declarations.push({
        name,
        declare: (context, authoringContext) => {
          const resolvedBinding =
            typeof binding === "function"
              ? (
                  binding as (
                    context: FlowAuthoringContext<Input, Record<never, never>>,
                  ) => InputBinding<
                    typeof definition extends TaskDefinition<
                      infer TaskInput,
                      unknown
                    >
                      ? TaskInput
                      : never
                  >
                )(authoringContext as never)
              : binding;
          const dependsOn = resolveFlowDependencies(
            taskOptions?.dependsOn,
            authoringContext,
          );
          const runOptions = {
            input: resolvedBinding,
            ...(taskOptions?.validateOutput === undefined
              ? {}
              : { validateOutput: taskOptions.validateOutput }),
            ...(dependsOn === undefined ? {} : { dependsOn }),
          };
          const sessionOption = taskOptions?.session;
          const session =
            typeof sessionOption === "function"
              ? sessionOption(authoringContext)
              : sessionOption;
          return context.run(definition, {
            ...runOptions,
            ...(session === undefined ? {} : { session }),
            ...(taskOptions?.workspace === undefined
              ? {}
              : { workspace: taskOptions.workspace }),
          });
        },
      });
      return builder as never;
    },
    validate: (name, validator, binding) => {
      declarations.push({
        name,
        declare: (context, authoringContext) => {
          const resolvedBinding =
            typeof binding === "function"
              ? (
                  binding as (
                    context: RuntimeFlowAuthoringContext<Input>,
                  ) => InputBinding<unknown>
                )(authoringContext)
              : binding;
          const validation = context.validate(validator, {
            input: resolvedBinding as InputBinding<never>,
          });
          return {
            nodeId: validation.nodeId,
            output: validation.output,
            validation: validation.result,
          };
        },
      });
      return builder as never;
    },
    repeat: (name, options) => {
      declarations.push({
        name,
        declare: (context, authoringContext) => {
          const initial =
            typeof options.initial === "function"
              ? (
                  options.initial as (
                    context: RuntimeFlowAuthoringContext<Input>,
                  ) => InputBinding<unknown>
                )(authoringContext)
              : options.initial;
          return context.repeat({
            initial: initial as InputBinding<never>,
            body: options.body,
            until: options.until,
            maximumIterations: options.maximumIterations,
          });
        },
      });
      return builder as never;
    },
    output: (binding) => {
      outputBinding = binding as FlowBinding<Input, unknown, Output>;
      return completed;
    },
  };

  return builder;
}
