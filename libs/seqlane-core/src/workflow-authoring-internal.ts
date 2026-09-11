import type {
  InputBinding,
  MechanicalTaskRef,
  TaskInvocation,
  ValueRef,
  ValidationInvocation,
} from "./bindings.js";
import type {
  RepeatBuildOptions,
  TaskDefinition,
  TaskInvocationOptions,
  ValidationInvocationOptions,
  Validator,
  AuthoredWorkflow,
  WorkspacePolicy,
} from "./contracts.js";

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
  readonly repeat: <State>(
    options: RepeatBuildOptions<State>,
  ) => MechanicalTaskRef<State>;
}

export type WorkflowBuilder<Input = unknown, Output = unknown> = (
  context: WorkflowBuildContext<Input>,
) => InputBinding<Output>;
