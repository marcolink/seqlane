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
  FlowTaskOptions,
  FlowWorkflowOptions,
  RunnableDefinition,
  ValidatedRepeatCondition,
  Validator,
  ValidatorDefinition,
  WorkflowDefinition,
} from "./contracts.js";
import type { WorkflowBuildContext } from "./workflow-authoring-internal.js";
import { taskDefinitionSchema } from "./contracts.js";
import type { ModelSelection } from "./models/model-ref.js";
import type {
  InputBinding,
  SessionCheckpointRef,
  ValueRef,
} from "./bindings.js";
import { z } from "zod";
import {
  isAuthoredWorkflow,
  registerWorkflowPlanBuilder,
} from "./workflow-internal.js";

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
  "execute" | "goal" | "output"
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
  if (Object.hasOwn(definition, "output")) {
    throw new TypeError("defineShellTask does not accept output");
  }
  const { executable, argv, ...base } = definition;
  return defineTask({
    ...base,
    output: shellTaskResultSchema,
    execute: async ({ input, context }) =>
      context.exec({ executable, argv: argv(input) }),
  });
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
 * Starts a typed Flow definition. Its declarations lower directly to the
 * private Plan builder when define() is called.
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
    define: () => {
      const declarationsSnapshot = [...declarations];
      const outputBindingSnapshot = outputBinding;
      const workflow: WorkflowDefinition<Input, Output> = {
        ...options,
      };
      return registerWorkflowPlanBuilder(workflow, (context) => {
        const authoringContext: RuntimeFlowAuthoringContext<Input> = {
          input: context.input,
          tasks: {},
        };
        for (const declaration of declarationsSnapshot) {
          authoringContext.tasks[declaration.name] = declaration.declare(
            context,
            authoringContext,
          );
        }
        if (outputBindingSnapshot === undefined) {
          throw new Error("Flow output is not defined");
        }
        return typeof outputBindingSnapshot === "function"
          ? (
              outputBindingSnapshot as (
                context: FlowAuthoringContext<Input, unknown>,
              ) => InputBinding<Output>
            )(authoringContext)
          : outputBindingSnapshot;
      });
    },
  };
  const builder = {
    task: (
      name: string,
      definition: RunnableDefinition<unknown, unknown>,
      binding: FlowBinding<Input, Record<never, never>, unknown>,
      taskOptions?:
        | FlowTaskOptions<unknown, Input, Record<never, never>>
        | FlowWorkflowOptions<Record<never, never>>,
    ) => {
      declarations.push({
        name,
        declare: (context, authoringContext) => {
          const resolvedBinding =
            typeof binding === "function"
              ? (
                  binding as (
                    context: FlowAuthoringContext<Input, Record<never, never>>,
                  ) => InputBinding<unknown>
                )(authoringContext as never)
              : binding;
          const dependsOn = resolveFlowDependencies(
            taskOptions?.dependsOn,
            authoringContext,
          );
          const runOptions = {
            input: resolvedBinding,
            ...(dependsOn === undefined ? {} : { dependsOn }),
          };
          if (isAuthoredWorkflow(definition)) {
            return context.run(definition, {
              ...runOptions,
              ...(taskOptions?.workspace === undefined
                ? {}
                : { workspace: taskOptions.workspace }),
            });
          }
          const taskOptionsTyped = taskOptions as
            | FlowTaskOptions<unknown, Input, Record<string, FlowHandle>>
            | undefined;
          const sessionOption = taskOptionsTyped?.session;
          const session =
            typeof sessionOption === "function"
              ? sessionOption(authoringContext)
              : sessionOption;
          return context.run(definition as TaskDefinition<unknown, unknown>, {
            ...runOptions,
            ...(taskOptionsTyped?.validateOutput === undefined
              ? {}
              : { validateOutput: taskOptionsTyped.validateOutput }),
            ...(session === undefined ? {} : { session }),
            ...(taskOptionsTyped?.workspace === undefined
              ? {}
              : { workspace: taskOptionsTyped.workspace }),
          });
        },
      });
      return builder as never;
    },
    validate: <Candidate>(
      name: string,
      validator: Validator<Candidate>,
      binding: FlowBinding<Input, Record<never, never>, Candidate>,
      validationOptions?: Omit<
        import("./contracts.js").ValidationInvocationOptions<Candidate>,
        "input"
      >,
    ) => {
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
            ...(validationOptions === undefined ? {} : validationOptions),
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
    repeat: <State>(
      name: string,
      options: import("./contracts.js").RepeatOptions<
        Input,
        Record<never, never>,
        State
      >,
    ) => {
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
    output: (
      binding: FlowBinding<Input, Record<string, FlowHandle>, Output>,
    ) => {
      outputBinding = binding as FlowBinding<Input, unknown, Output>;
      return completed;
    },
  } as unknown as FlowBuilder<Input, Output, Record<never, never>>;

  return builder;
}
