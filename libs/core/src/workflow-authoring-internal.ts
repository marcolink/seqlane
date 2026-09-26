import type {
  InputBinding,
  MechanicalTaskRef,
  TaskInvocation,
  ValueRef,
  ValidationInvocation,
} from "./bindings.js";
import type {
  RunnableDefinition,
  UntilContext,
  NextInputContext,
  TaskDefinition,
  TaskInvocationOptions,
  ValidationInvocationOptions,
  Validator,
  AuthoredWorkflow,
  WorkspacePolicy,
} from "./contracts.js";

export interface RepeatBuildOptions<TaskInput, TaskOutput> {
  readonly initial: InputBinding<TaskInput>;
  readonly runnable: RunnableDefinition<TaskInput, TaskOutput>;
  readonly until: (
    context: Pick<UntilContext<TaskOutput>, "result">,
  ) => ValueRef<boolean>;
  readonly nextInput?: (
    context: Pick<NextInputContext<TaskInput, TaskOutput>, "input" | "result">,
  ) => InputBinding<TaskInput>;
  readonly maxIterations: number;
  readonly dependsOn?: readonly { readonly nodeId: string }[];
  readonly workspace?: WorkspacePolicy;
  readonly session?: import("./contracts.js").SessionPolicy;
  /** Optional output validator applied after every repeat attempt. */
  readonly validateOutput?: Validator<TaskOutput>;
}

export interface ChoiceArmBuildOptions<Input, Output> {
  readonly runnable: RunnableDefinition<Input, Output>;
  readonly input: InputBinding<Input>;
  readonly dependsOn?: readonly { readonly nodeId: string }[];
  readonly session?: import("./contracts.js").SessionPolicy;
  readonly workspace?: WorkspacePolicy;
  readonly validateOutput?: Validator<Output>;
}

export interface ChoiceBuildOptions<
  TrueInput,
  TrueOutput,
  FalseInput,
  FalseOutput,
> {
  readonly condition: ValueRef<boolean>;
  readonly then: ChoiceArmBuildOptions<TrueInput, TrueOutput>;
  readonly else: ChoiceArmBuildOptions<FalseInput, FalseOutput>;
}

export interface WorkflowBuildContext<Input = unknown> {
  readonly input: ValueRef<Input>;
  readonly run: {
    <
      TaskInput,
      TaskOutput,
      Options extends TaskInvocationOptions<TaskInput, TaskOutput>,
    >(
      task: TaskDefinition<TaskInput, TaskOutput>,
      options: Options,
    ): TaskInvocation<TaskOutput, Options["session"]>;
    <WorkflowInput, WorkflowOutput>(
      workflow: AuthoredWorkflow<WorkflowInput, WorkflowOutput>,
      options: {
        readonly input: InputBinding<WorkflowInput>;
        readonly dependsOn?: readonly { readonly nodeId: string }[];
        readonly workspace?: WorkspacePolicy;
      },
    ): MechanicalTaskRef<WorkflowOutput>;
  };
  readonly validate: <Candidate>(
    validator: Validator<Candidate>,
    options: ValidationInvocationOptions<Candidate>,
  ) => ValidationInvocation<Candidate>;
  readonly repeat: <TaskInput, TaskOutput>(
    options: RepeatBuildOptions<TaskInput, TaskOutput>,
  ) => MechanicalTaskRef<TaskOutput>;
  readonly choose: <TrueInput, TrueOutput, FalseInput, FalseOutput>(
    options: ChoiceBuildOptions<TrueInput, TrueOutput, FalseInput, FalseOutput>,
  ) => MechanicalTaskRef<TrueOutput | FalseOutput>;
}

export type WorkflowBuilder<Input = unknown, Output = unknown> = (
  context: WorkflowBuildContext<Input>,
) => InputBinding<Output>;
