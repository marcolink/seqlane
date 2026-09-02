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
import type {
  InputBinding,
  SessionCheckpointRef,
  ValueRef,
} from "./bindings.js";

export function defineValidator<Input>(
  definition: ValidatorDefinition<Input>,
): ValidatorDefinition<Input> {
  return definition;
}

export function defineTask<Input, Output>(
  definition: TaskDefinition<Input, Output>,
): TaskDefinition<Input, Output> {
  return definition;
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

export function isolated(): SessionPolicy {
  return { type: "isolated" };
}

export function reuse(from: SessionCheckpointRef): SessionPolicy {
  return { type: "reuse", from };
}

export function branch(from: SessionCheckpointRef): SessionPolicy {
  return { type: "branch", from };
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
          const session =
            typeof taskOptions?.session === "function"
              ? taskOptions.session(authoringContext)
              : taskOptions?.session;
          return context.run(definition, {
            input: resolvedBinding,
            ...(taskOptions?.validateOutput === undefined
              ? {}
              : { validateOutput: taskOptions.validateOutput }),
            ...(dependsOn === undefined ? {} : { dependsOn }),
            ...(session === undefined ? {} : { session }),
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
