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
}

export type WorkflowBuilder<Input = unknown, Output = unknown> = (
  context: WorkflowBuildContext<Input>,
) => InputBinding<Output>;
