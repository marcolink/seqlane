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

/** Runtime schema used by public authoring contracts. */
export type SeqlaneSchema<T = unknown> = z.ZodType<T>;

export interface TaskSchema<Input = unknown, Output = unknown> {
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
}

interface TaskDefinitionBase<Input = unknown, Output = unknown> {
  readonly id: TaskId;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
  readonly observability?: SeqlaneTaskObservability;
}

export interface AgentTaskRequest {
  readonly goal: string;
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
    readonly executable: string;
    readonly argv?: readonly string[];
    /** Optional foreground process timeout in milliseconds. */
    readonly timeoutMs?: number;
  }): Promise<TaskExecResult>;
  runAgent(request: AgentTaskRequest): Promise<unknown>;
}

export interface TaskDefinition<
  Input = unknown,
  Output = unknown,
> extends TaskDefinitionBase<Input, Output> {
  execute(request: {
    readonly input: Input;
    readonly signal: AbortSignal;
    readonly context: TaskContext;
  }): Promise<Output>;
}

const taskDefinitionBaseSchema = {
  id: z.string(),
  input: z.custom<z.ZodType>((value) => value instanceof z.ZodType),
  output: z.custom<z.ZodType>((value) => value instanceof z.ZodType),
};

export const taskDefinitionSchema = z.looseObject({
  ...taskDefinitionBaseSchema,
  execute: z.custom((value) => typeof value === "function"),
});

export interface TaskInvocationOptions<Input, Output> {
  readonly input: InputBinding<Input>;
  readonly validateOutput?: Validator<Output>;
  readonly dependsOn?: readonly TaskDependency[];
  readonly session?: SessionPolicy;
  readonly workspace?: WorkspacePolicy;
}

export interface ValidationInvocationOptions<Input> {
  readonly input: InputBinding<Input>;
  readonly workspace?: WorkspacePolicy;
}

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

export type ValidationTaskDefinition<Input = unknown> = TaskDefinition<
  Input,
  ValidationResult
>;

export type Validator<Input = unknown> =
  ValidatorDefinition<Input> | TaskDefinition<Input, ValidationResult>;

export type ValidatorDefinitionRegistry = ReadonlyMap<
  string,
  ValidatorDefinition<unknown>
>;

export type TaskSchemaRegistry = ReadonlyMap<TaskId, TaskSchema>;
export type TaskDefinitionRegistry = ReadonlyMap<
  TaskId,
  TaskDefinition<unknown, unknown>
>;

/** Canonical runtime schemas for definition registries crossing boundaries. */
export const taskDefinitionRegistrySchema = z
  .map(z.string().min(1), taskDefinitionSchema)
  .pipe(
    z.custom<Map<string, z.output<typeof taskDefinitionSchema>>>(
      (value): value is Map<string, z.output<typeof taskDefinitionSchema>> =>
        value instanceof Map &&
        [...value.entries()].every(([id, definition]) => id === definition.id),
      "Registry keys must match task definition IDs",
    ),
  );
export const validatorDefinitionSchema = z.looseObject({
  id: z.string().min(1),
  input: z.custom<z.ZodType>((value) => value instanceof z.ZodType),
  validate: z.custom((value) => typeof value === "function"),
});
export const validatorDefinitionRegistrySchema = z
  .map(z.string().min(1), validatorDefinitionSchema)
  .pipe(
    z.custom<Map<string, z.output<typeof validatorDefinitionSchema>>>(
      (
        value,
      ): value is Map<string, z.output<typeof validatorDefinitionSchema>> =>
        value instanceof Map &&
        [...value.entries()].every(([id, definition]) => id === definition.id),
      "Registry keys must match validator definition IDs",
    ),
  );

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

export interface WorkflowDefinition<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
}

declare const authoredWorkflowBrand: unique symbol;

/** Workflow definition produced by the fluent authoring API. */
export interface AuthoredWorkflow<
  Input = unknown,
  Output = unknown,
> extends WorkflowDefinition<Input, Output> {
  readonly [authoredWorkflowBrand]: true;
}

export type FlowHandle<
  Output = unknown,
  Session = undefined,
> = Session extends undefined
  ? MechanicalTaskRef<Output>
  : TaskInvocation<
      Output,
      Session extends SessionPolicy ? Session : SessionPolicy
    >;

export interface FlowAuthoringContext<Input, Handles> {
  readonly input: ValueRef<Input>;
  readonly tasks: Handles;
}

export type FlowBinding<Input, Handles, Target> =
  | InputBinding<Target>
  | ((context: FlowAuthoringContext<Input, Handles>) => InputBinding<Target>);

export interface FlowTaskOptions<Output, Input = unknown, Handles = unknown> {
  readonly validateOutput?: Validator<Output>;
  readonly dependsOn?: readonly (keyof Handles & string)[];
  readonly session?:
    | SessionPolicy
    | ((context: FlowAuthoringContext<Input, Handles>) => SessionPolicy);
  readonly workspace?: WorkspacePolicy;
}

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
  task<
    Name extends string,
    TaskInput,
    TaskOutput,
    Options extends FlowTaskOptions<TaskOutput, Input, Handles> =
      FlowTaskOptions<TaskOutput, Input, Handles>,
  >(
    name: LiteralUnusedFlowName<Name, Handles>,
    definition: TaskDefinition<TaskInput, TaskOutput>,
    binding: FlowBinding<Input, Handles, TaskInput>,
    options?: Options,
  ): FlowBuilder<
    Input,
    Output,
    Handles & Record<Name, FlowHandle<TaskOutput, Options["session"]>>
  >;
  validate<Name extends string, Candidate>(
    name: LiteralUnusedFlowName<Name, Handles>,
    validator: Validator<Candidate>,
    binding: FlowBinding<Input, Handles, Candidate>,
    options?: Omit<ValidationInvocationOptions<Candidate>, "input">,
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
  define(): AuthoredWorkflow<Input, Output>;
}

export interface CreateFlowOptions<Input, Output> {
  readonly id: string;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
}

export interface RepeatBodyContext<State> {
  readonly input: ValueRef<State>;
  readonly task: {
    <
      TaskInput,
      TaskOutput,
      Options extends TaskInvocationOptions<TaskInput, TaskOutput>,
    >(
      definition: TaskDefinition<TaskInput, TaskOutput>,
      options: Omit<Options, "validateOutput">,
    ): TaskInvocation<TaskOutput, Options["session"]>;
  };
  readonly validate: <Candidate>(
    validator: Validator<Candidate>,
    options: ValidationInvocationOptions<Candidate>,
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
