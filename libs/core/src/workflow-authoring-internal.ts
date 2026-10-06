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
  AuthoredWorkflow,
  Validator,
} from "./contracts.js";

export interface RepeatBuildOptions<TaskInput, TaskOutput> extends Omit<
  TaskInvocationOptions<TaskInput, TaskOutput>,
  "input"
> {
  readonly initial: InputBinding<TaskInput>;
  readonly runnable: RunnableDefinition<TaskInput, TaskOutput>;
  readonly until: (
    context: Pick<UntilContext<TaskOutput>, "result">,
  ) => ValueRef<boolean>;
  readonly nextInput?: (
    context: Pick<NextInputContext<TaskInput, TaskOutput>, "input" | "result">,
  ) => InputBinding<TaskInput>;
  readonly maxIterations: number;
}

export interface RunnableBuildOptions<
  Input,
  Output,
> extends TaskInvocationOptions<Input, Output> {
  readonly runnable: RunnableDefinition<Input, Output>;
}

export type ChoiceArmBuildOptions<Input, Output> = RunnableBuildOptions<
  Input,
  Output
>;

export type WorkflowInvocationOptions<Input> = Pick<
  TaskInvocationOptions<Input, unknown>,
  "input" | "dependsOn" | "workspace"
>;

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
      options: WorkflowInvocationOptions<WorkflowInput>,
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
