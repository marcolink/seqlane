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
  UntilContext,
  UntilOptions,
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
  readonly timeoutMs?: number;
  readonly onError?: (cause: unknown) => ShellTaskResult;
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
  const { executable, argv, timeoutMs, onError, ...base } = definition;
  return defineTask({
    ...base,
    output: shellTaskResultSchema,
    execute: async ({ input, context }) => {
      try {
        return await context.exec({
          executable,
          argv: argv(input),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      } catch (cause) {
        if (onError === undefined) throw cause;
        return onError(cause);
      }
    },
  });
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

type RuntimeTaskOptions<Input> =
  | FlowTaskOptions<unknown, Input, Record<string, FlowHandle>>
  | FlowWorkflowOptions<Record<string, FlowHandle>>
  | undefined;

type RuntimeTaskBinding<Input> = FlowBinding<
  Input,
  Record<string, FlowHandle>,
  unknown
>;

interface PendingTask<Input> {
  readonly name: string;
  readonly definition: RunnableDefinition<unknown, unknown>;
  readonly binding: RuntimeTaskBinding<Input>;
  readonly options: RuntimeTaskOptions<Input>;
  readonly declaration: FlowDeclaration<Input>;
}

function resolveTaskBinding<Input>(
  binding: RuntimeTaskBinding<Input>,
  authoringContext: RuntimeFlowAuthoringContext<Input>,
): InputBinding<unknown> {
  return typeof binding === "function" ? binding(authoringContext) : binding;
}

function resolveSessionOption<Input>(
  options: RuntimeTaskOptions<Input>,
  authoringContext: RuntimeFlowAuthoringContext<Input>,
): import("./contracts.js").SessionPolicy | undefined {
  const sessionOption =
    "session" in (options ?? {})
      ? (options as FlowTaskOptions<unknown>).session
      : undefined;
  return typeof sessionOption === "function"
    ? sessionOption(authoringContext)
    : sessionOption;
}

function createTaskDeclaration<Input>(
  name: string,
  definition: RunnableDefinition<unknown, unknown>,
  binding: RuntimeTaskBinding<Input>,
  options: RuntimeTaskOptions<Input>,
): FlowDeclaration<Input> {
  return {
    name,
    declare: (context, authoringContext) => {
      const resolvedBinding = resolveTaskBinding(binding, authoringContext);
      const dependsOn = resolveFlowDependencies(
        options?.dependsOn,
        authoringContext,
      );
      const runOptions = {
        input: resolvedBinding,
        ...(dependsOn === undefined ? {} : { dependsOn }),
      };
      if (isAuthoredWorkflow(definition)) {
        return context.run(definition, {
          ...runOptions,
          ...(options?.workspace === undefined
            ? {}
            : { workspace: options.workspace }),
        });
      }
      const taskOptions = options as
        FlowTaskOptions<unknown, Input, Record<string, FlowHandle>> | undefined;
      const session = resolveSessionOption(taskOptions, authoringContext);
      return context.run(definition as TaskDefinition<unknown, unknown>, {
        ...runOptions,
        ...(taskOptions?.validateOutput === undefined
          ? {}
          : { validateOutput: taskOptions.validateOutput }),
        ...(session === undefined ? {} : { session }),
        ...(taskOptions?.workspace === undefined
          ? {}
          : { workspace: taskOptions.workspace }),
      });
    },
  };
}

function createUntilDeclaration<Input>(
  pending: PendingTask<Input>,
  condition: (
    context: UntilContext<unknown, Record<string, FlowHandle>>,
  ) => ValueRef<boolean>,
  options: UntilOptions<unknown, unknown, Record<string, FlowHandle>>,
): FlowDeclaration<Input> {
  return {
    name: pending.name,
    declare: (context, authoringContext) => {
      const initial = resolveTaskBinding(pending.binding, authoringContext);
      const dependsOn = resolveFlowDependencies(
        pending.options?.dependsOn,
        authoringContext,
      );
      const session = resolveSessionOption(pending.options, authoringContext);
      const nextInput = options.nextInput;
      return context.repeat({
        initial,
        runnable: pending.definition,
        until: ({ result }) =>
          condition({ result, tasks: authoringContext.tasks }),
        nextInput:
          nextInput === undefined
            ? undefined
            : ({ input, result }) =>
                nextInput({
                  input,
                  result,
                  tasks: authoringContext.tasks,
                }),
        maxIterations: options.maxIterations,
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...(pending.options?.workspace === undefined
          ? {}
          : { workspace: pending.options.workspace }),
        ...(session === undefined ? {} : { session }),
        ...(pending.options === undefined ||
        !("validateOutput" in pending.options) ||
        pending.options.validateOutput === undefined
          ? {}
          : { validateOutput: pending.options.validateOutput }),
      });
    },
  };
}

/**
 * Starts a typed Flow definition. Its declarations lower directly to the
 * private Plan builder when define() is called.
 */
export function createFlow<Input, Output>(
  options: CreateFlowOptions<Input, Output>,
): FlowBuilder<Input, Output, Record<never, never>> {
  const declarations: (
    FlowDeclaration<Input> | FlowValidationDeclaration<Input>
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
  let pendingTask: PendingTask<Input> | undefined;
  const builder = {
    task: (
      name: string,
      definition: RunnableDefinition<unknown, unknown>,
      binding: FlowBinding<Input, Record<never, never>, unknown>,
      taskOptions?:
        | FlowTaskOptions<unknown, Input, Record<never, never>>
        | FlowWorkflowOptions<Record<never, never>>,
    ) => {
      const runtimeBinding = binding as RuntimeTaskBinding<Input>;
      const runtimeOptions = taskOptions as RuntimeTaskOptions<Input>;
      const declaration = createTaskDeclaration(
        name,
        definition,
        runtimeBinding,
        runtimeOptions,
      );
      declarations.push(declaration);
      pendingTask = {
        name,
        definition,
        binding: runtimeBinding,
        options: runtimeOptions,
        declaration,
      };
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
      pendingTask = undefined;
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
    until: (
      condition: (context: UntilContext<unknown>) => ValueRef<boolean>,
      options: UntilOptions<unknown, unknown>,
    ) => {
      const task = pendingTask;
      if (task === undefined || declarations.at(-1) !== task.declaration) {
        throw new Error("until() must follow a task declaration");
      }
      declarations[declarations.length - 1] = createUntilDeclaration(
        task,
        condition,
        options,
      );
      pendingTask = undefined;
      return builder as never;
    },
    output: (
      binding: FlowBinding<Input, Record<string, FlowHandle>, Output>,
    ) => {
      pendingTask = undefined;
      outputBinding = binding as FlowBinding<Input, unknown, Output>;
      return completed;
    },
  } as unknown as FlowBuilder<Input, Output, Record<never, never>>;

  return builder;
}
