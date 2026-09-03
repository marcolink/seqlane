import type {
  InputBinding,
  MechanicalTaskRef,
  SessionCheckpointRef,
  TaskInvocation,
  ValueRef,
  ValidationInvocation,
} from "./bindings.js";
import type { ModelSelection } from "./models/model-ref.js";
import { z } from "zod";

export type WorkId = string;
export type RunId = string;
export type InvocationId = string;
export type PlanNodeId = string;
export type TaskId = string;

export const workspacePolicySchema = z.enum(["shared", "exclusive"]);

export type WorkspacePolicy = z.infer<typeof workspacePolicySchema>;

export interface TaskDependency {
  readonly nodeId: PlanNodeId;
}

export type SessionPolicy =
  | { readonly type: "isolated"; readonly model?: ModelSelection }
  | { readonly type: "reuse"; readonly from: SessionCheckpointRef }
  | {
      readonly type: "branch";
      readonly from: SessionCheckpointRef;
      readonly model?: ModelSelection;
    };

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type SeqlaneJsonPointer = string;

export interface SeqlaneStudioValueSelection {
  readonly includePaths: readonly SeqlaneJsonPointer[];
}

export interface SeqlaneActivityObservability {
  readonly input?: SeqlaneStudioValueSelection;
  readonly output?: SeqlaneStudioValueSelection;
  readonly metadata?: SeqlaneStudioValueSelection;
}

export interface SeqlaneTaskObservability {
  readonly studio?: {
    readonly input?: SeqlaneStudioValueSelection;
    readonly result?: SeqlaneStudioValueSelection;
    readonly activity?: SeqlaneActivityObservability;
  };
}

export interface SeqlaneSchema<T = unknown> {
  parse(value: unknown): T;
}

export interface TaskSchema<Input = unknown, Output = unknown> {
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
}

interface TaskDefinitionBase<Input = unknown, Output = unknown> {
  readonly id: TaskId;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
  readonly workspace?: WorkspacePolicy;
  readonly observability?: SeqlaneTaskObservability;
}

type TaskGoal<Input> = {
  bivarianceHack(input: Input): string;
}["bivarianceHack"];

type TaskExecutor<Input, Output> = {
  bivarianceHack(input: Input, context: TaskContext): Promise<Output>;
}["bivarianceHack"];

export interface AgentTaskDefinition<
  Input = unknown,
  Output = unknown,
> extends TaskDefinitionBase<Input, Output> {
  readonly goal: TaskGoal<Input>;
  readonly execute?: never;
  readonly instructions?: readonly string[];
  readonly references?: readonly string[];
}

export interface TaskExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TaskContext {
  exec(request: {
    readonly command: string;
    readonly args?: readonly string[];
  }): Promise<TaskExecResult>;
}

export interface LocalTaskDefinition<
  Input = unknown,
  Output = unknown,
> extends TaskDefinitionBase<Input, Output> {
  readonly goal?: never;
  readonly execute: TaskExecutor<Input, Output>;
}

export type TaskDefinition<Input = unknown, Output = unknown> =
  AgentTaskDefinition<Input, Output> | LocalTaskDefinition<Input, Output>;

const taskDefinitionBaseSchema = {
  id: z.string(),
  input: z.looseObject({
    parse: z.custom((value) => typeof value === "function"),
  }),
  output: z.looseObject({
    parse: z.custom((value) => typeof value === "function"),
  }),
};

export const taskDefinitionSchema = z.union([
  z.looseObject({
    ...taskDefinitionBaseSchema,
    goal: z.custom((value) => typeof value === "function"),
    execute: z.never().optional(),
  }),
  z.looseObject({
    ...taskDefinitionBaseSchema,
    goal: z.never().optional(),
    execute: z.custom((value) => typeof value === "function"),
  }),
]);

export interface AgentTaskInvocationOptions<Input, Output> {
  readonly input: InputBinding<Input>;
  readonly validateOutput?: Validator<Output>;
  readonly dependsOn?: readonly TaskDependency[];
  readonly session?: SessionPolicy;
}

export interface LocalTaskInvocationOptions<Input, Output> {
  readonly input: InputBinding<Input>;
  readonly validateOutput?: Validator<Output>;
  readonly dependsOn?: readonly TaskDependency[];
}

/** @deprecated Use AgentTaskInvocationOptions or LocalTaskInvocationOptions. */
export type TaskInvocationOptions<Input, Output> = AgentTaskInvocationOptions<
  Input,
  Output
>;

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: SeqlaneJsonPointer;
}

export interface ValidationPassed {
  readonly success: true;
  readonly evidence?: JsonValue;
}

export interface ValidationFailed {
  readonly success: false;
  readonly issues: readonly [ValidationIssue, ...ValidationIssue[]];
  readonly evidence?: JsonValue;
}

export type ValidationResult = ValidationPassed | ValidationFailed;

export interface ValidatorDefinition<Input = unknown> {
  readonly id: string;
  readonly input: SeqlaneSchema<Input>;
  readonly validate: {
    bivarianceHack(input: Input): ValidationResult;
  }["bivarianceHack"];
}

export type ValidationTaskDefinition<Input = unknown> = AgentTaskDefinition<
  Input,
  ValidationResult
>;

export type Validator<Input = unknown> =
  ValidatorDefinition<Input> | ValidationTaskDefinition<Input>;

export type ValidatorDefinitionRegistry = ReadonlyMap<
  string,
  ValidatorDefinition<unknown>
>;

export type TaskSchemaRegistry = ReadonlyMap<TaskId, TaskSchema>;
export type TaskDefinitionRegistry = ReadonlyMap<
  TaskId,
  TaskDefinition<unknown, unknown>
>;

export interface WorkflowBuildContext<Input = unknown> {
  readonly input: ValueRef<Input>;
  readonly run: {
    <TaskInput, TaskOutput>(
      task: AgentTaskDefinition<TaskInput, TaskOutput>,
      options: AgentTaskInvocationOptions<TaskInput, TaskOutput>,
    ): TaskInvocation<TaskOutput>;
    <TaskInput, TaskOutput>(
      task: LocalTaskDefinition<TaskInput, TaskOutput>,
      options: LocalTaskInvocationOptions<TaskInput, TaskOutput>,
    ): MechanicalTaskRef<TaskOutput>;
  };
  readonly validate: <Candidate>(
    validator: Validator<Candidate>,
    options: { readonly input: InputBinding<Candidate> },
  ) => ValidationInvocation<Candidate>;
  readonly repeat: <State>(
    options: RepeatBuildOptions<State>,
  ) => MechanicalTaskRef<State>;
}

export type WorkflowBuilder<Input = unknown, Output = unknown> = (
  context: WorkflowBuildContext<Input>,
) => InputBinding<Output>;

export interface WorkflowDefinition<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
  readonly build: WorkflowBuilder<Input, Output>;
}

export interface FlowHandle<Output = unknown> {
  readonly output: ValueRef<Output>;
}

export interface AgentFlowHandle<Output = unknown> extends FlowHandle<Output> {
  readonly session: SessionCheckpointRef;
}

export interface FlowAuthoringContext<Input, Handles> {
  readonly input: ValueRef<Input>;
  readonly tasks: Handles;
}

export type FlowBinding<Input, Handles, Target> =
  | InputBinding<Target>
  | ((context: FlowAuthoringContext<Input, Handles>) => InputBinding<Target>);

export interface AgentFlowTaskOptions<
  Output,
  Input = unknown,
  Handles = unknown,
> {
  readonly validateOutput?: Validator<Output>;
  readonly dependsOn?: readonly (keyof Handles & string)[];
  readonly session?:
    | SessionPolicy
    | ((context: FlowAuthoringContext<Input, Handles>) => SessionPolicy);
}

export interface LocalFlowTaskOptions<Output, Handles = unknown> {
  readonly validateOutput?: Validator<Output>;
  readonly dependsOn?: readonly (keyof Handles & string)[];
}

/** @deprecated Use AgentFlowTaskOptions or LocalFlowTaskOptions. */
export type FlowTaskOptions<
  Output,
  Input = unknown,
  Handles = unknown,
> = AgentFlowTaskOptions<Output, Input, Handles>;

export interface FlowValidationHandle<
  Output = unknown,
> extends FlowHandle<Output> {
  readonly validation: ValueRef<ValidationResult>;
}

type LiteralUnusedFlowName<Name extends string, Handles> = string extends Name
  ? never
  : Name extends keyof Handles
    ? never
    : Name;

export interface FlowBuilder<Input, Output, Handles> {
  task<Name extends string, TaskInput, TaskOutput>(
    name: LiteralUnusedFlowName<Name, Handles>,
    definition: AgentTaskDefinition<TaskInput, TaskOutput>,
    binding: FlowBinding<Input, Handles, TaskInput>,
    options?: AgentFlowTaskOptions<TaskOutput, Input, Handles>,
  ): FlowBuilder<
    Input,
    Output,
    Handles & Record<Name, AgentFlowHandle<TaskOutput>>
  >;
  task<Name extends string, TaskInput, TaskOutput>(
    name: LiteralUnusedFlowName<Name, Handles>,
    definition: LocalTaskDefinition<TaskInput, TaskOutput>,
    binding: FlowBinding<Input, Handles, TaskInput>,
    options?: LocalFlowTaskOptions<TaskOutput, Handles>,
  ): FlowBuilder<Input, Output, Handles & Record<Name, FlowHandle<TaskOutput>>>;
  validate<Name extends string, Candidate>(
    name: LiteralUnusedFlowName<Name, Handles>,
    validator: Validator<Candidate>,
    binding: FlowBinding<Input, Handles, Candidate>,
  ): FlowBuilder<
    Input,
    Output,
    Handles & Record<Name, FlowValidationHandle<Candidate>>
  >;
  repeat<Name extends string, State>(
    name: LiteralUnusedFlowName<Name, Handles>,
    options: RepeatOptions<Input, Handles, State>,
  ): FlowBuilder<Input, Output, Handles & Record<Name, FlowHandle<State>>>;
  output(
    binding: FlowBinding<Input, Handles, Output>,
  ): CompletedFlow<Input, Output>;
}

export interface CompletedFlow<Input, Output> {
  define(): WorkflowDefinition<Input, Output>;
}

export interface CreateFlowOptions<Input, Output> {
  readonly id: string;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
}

export interface RepeatBodyContext<State> {
  readonly input: ValueRef<State>;
  readonly task: {
    <TaskInput, TaskOutput>(
      definition: AgentTaskDefinition<TaskInput, TaskOutput>,
      options: Omit<
        AgentTaskInvocationOptions<TaskInput, TaskOutput>,
        "validateOutput"
      >,
    ): TaskInvocation<TaskOutput>;
    <TaskInput, TaskOutput>(
      definition: LocalTaskDefinition<TaskInput, TaskOutput>,
      options: Omit<
        LocalTaskInvocationOptions<TaskInput, TaskOutput>,
        "validateOutput"
      >,
    ): MechanicalTaskRef<TaskOutput>;
  };
  readonly validate: <Candidate>(
    validator: Validator<Candidate>,
    options: { readonly input: InputBinding<Candidate> },
  ) => ValidationInvocation<Candidate>;
}

export interface ValidatedRepeatCondition<State> {
  readonly type: "validated";
  readonly validator: Validator<State>;
}

export interface RepeatOptions<OuterInput, OuterHandles, State> {
  readonly initial: FlowBinding<OuterInput, OuterHandles, State>;
  readonly body: (context: RepeatBodyContext<State>) => ValueRef<State>;
  readonly until:
    | ((context: { readonly output: ValueRef<State> }) => ValueRef<boolean>)
    | ValidatedRepeatCondition<State>;
  readonly maximumIterations: number;
}

export interface RepeatBuildOptions<State> {
  readonly initial: InputBinding<State>;
  readonly body: (context: RepeatBodyContext<State>) => ValueRef<State>;
  readonly until:
    | ((context: { readonly output: ValueRef<State> }) => ValueRef<boolean>)
    | ValidatedRepeatCondition<State>;
  readonly maximumIterations: number;
}

export type InteractionRequirement =
  "user-input" | "confirmation" | "option-selection";
