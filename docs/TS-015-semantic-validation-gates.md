# TS-015 — Semantic Validation Gates and Evaluators

**Status:** Implemented
**Implements:** ADR-015
**Depends on:** TS-001, TS-003, TS-005, TS-008, TS-012
**Scope:** MVP semantic validation

## 1. Objective

Add a Seqlane-owned validation primitive that confirms semantic acceptance
before dependent work runs.

```text
candidate value
      ↓
validation node
   ↙       ↘
pass       fail
  ↓          ↓
continue   run failure
```

The primitive must support deterministic mechanical checks and task-backed
evaluators, including evaluators whose task uses a prompt. It must preserve
Seqlane's schema validation, serializable Plan IR, executor-neutral core, and
autonomous runtime.

## 2. Normative Terms

- **Candidate:** The typed value submitted for semantic validation.
- **Mechanical validator:** A core-compatible, read-only function registered
  with the workflow. It does not use an executor.
- **Evaluator task:** A normal Seqlane task whose output is a
  `ValidationResult`. It may use any private runtime executor.
- **Gate:** A validation gate that applies a continuation policy to exactly one
  validation check.
- **Repeat postcondition:** A gate policy that treats false as a bounded repeat
  condition instead of an immediate Run failure.

## 3. Core Contracts

Add these Mastra-independent contracts to `@seqlane/core`.

```ts
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
  readonly validate: (input: Input) => ValidationResult;
}

export type Validator<Input = unknown> =
  | ValidatorDefinition<Input>
  | ValidationTaskDefinition<Input>;

export type ValidatorDefinitionRegistry = ReadonlyMap<
  string,
  ValidatorDefinition
>;

export function defineValidator<Input>(
  definition: ValidatorDefinition<Input>,
): ValidatorDefinition<Input>;

export type ValidationTaskDefinition<Input> = TaskDefinition<
  Input,
  ValidationResult
>;

export interface ValidationInvocation<Output = unknown> {
  readonly nodeId: PlanNodeId;
  /** The candidate value represented by the gate. */
  readonly output: ValueRef<Output>;
  /** The structured verdict and evidence. */
  readonly result: ValueRef<ValidationResult>;
}
```

`ValidationResult` is the only semantic verdict contract. `success: false`
must contain at least one issue. Evidence must be JSON-safe. Evidence is
diagnostic data, not an authority signal; `success` is the only control-flow
field.

Each gate accepts exactly one `ValidatorDefinition` or evaluator task. A
validator must be read-only; an evaluator task used as a validator must also
be read-only with respect to workflow state and external side effects.

Task output validation is the preferred common path. It is an optional task
authoring option that lowers to the task followed by a fail-closed validation
gate while keeping the task handle's `output` as the validated candidate.

Flow operation names are author-defined, compile-time string literals used as
typed local handle keys. They are not task IDs, validator IDs, workflow IDs, or
runtime Plan node IDs. Names must be unique within one Flow. Validator IDs are
separate registry identities and must also be unique within one built workflow.

Explicit validation handles protect only their dependents. Authors that need a
task output to be validated for all normal consumers should use
`validateOutput`; this is the preferred safe-by-default path.

The V1 failure policy is fail-closed for validation gates. There is no retry,
recovery route, or approval policy in this specification. A repeat
postcondition is a gate policy that treats `success: false` as a bounded loop
condition instead of an immediate Run failure.

## 4. Authoring API

Extend `WorkflowBuildContext` with:

```ts
interface WorkflowBuildContext<Input = unknown> {
  readonly input: ValueRef<Input>;
  readonly run: <TaskInput, TaskOutput>(
    task: TaskDefinition<TaskInput, TaskOutput>,
    options: {
      readonly input: InputBinding<TaskInput>;
      readonly validateOutput?: Validator<TaskOutput>;
    },
  ) => TaskInvocation<TaskOutput>;
  readonly validate: <Candidate>(
    validator: Validator<Candidate>,
    options: { readonly input: InputBinding<Candidate> },
  ) => ValidationInvocation<Candidate>;
  readonly repeat: <State>(
    options: RepeatBuildOptions<State>,
  ) => TaskInvocation<State>;
}
```

`validate` accepts either a mechanical `ValidatorDefinition` or an evaluator
task directly. The candidate input can be a `ValueRef`, a nested binding, or
a literal value matching the validator input type. `run` with
`validateOutput` is the recommended syntax when the candidate is a task
output. Explicit `validate` remains available for arbitrary values, final
results, and repeat-body checks.

The Flow DSL adds equivalent operations:

```ts
interface FlowValidationHandle<Output> extends FlowHandle<Output> {
  readonly validation: ValueRef<ValidationResult>;
}

interface FlowBuilder<Input, Output, Handles> {
  task<Name extends string, TaskInput, TaskOutput>(
    name: LiteralUnusedFlowName<Name, Handles>,
    definition: TaskDefinition<TaskInput, TaskOutput>,
    binding: FlowBinding<Input, Handles, TaskInput>,
    options?: FlowTaskOptions<TaskOutput>,
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
}

interface FlowTaskOptions<Output> {
  readonly validateOutput?: Validator<Output>;
}
```

The existing `repeat` and `output` operations retain their current
semantics. Extend `task` with an optional fourth `FlowTaskOptions` argument.
When `validateOutput` is present, the task handle's `output` references the
validated candidate. A validation handle's `output` is the candidate and its
`validation` is the verdict. Explicit validation handles must be used by
downstream bindings that need their gate; a raw source handle remains
available for intentionally independent work.

The repeat body context exposes `task` and `validate`. A body-level validation
gate failure fails the Run. Repeat convergence uses the same `until` field with
either a boolean reference or `validatedBy(validator)`.

## 5. Repeat Postcondition API

Extend repeat authoring with one `until` option that accepts either the
existing boolean reference or a validated postcondition:

```ts
export interface ValidatedRepeatCondition<State> {
  readonly type: "validated";
  readonly validator: Validator<State>;
}

export function validatedBy<State>(
  validator: Validator<State>,
): ValidatedRepeatCondition<State>;

interface RepeatOptions<OuterInput, OuterHandles, State> {
  readonly initial: FlowBinding<OuterInput, OuterHandles, State>;
  readonly body: (context: RepeatBodyContext<State>) => ValueRef<State>;
  readonly until:
    | ((context: { readonly output: ValueRef<State> }) => ValueRef<boolean>)
    | ValidatedRepeatCondition<State>;
  readonly maximumIterations: number;
}
```

The non-Flow repeat API uses the same shape:

```ts
interface RepeatBuildOptions<State> {
  readonly initial: InputBinding<State>;
  readonly body: (context: RepeatBodyContext<State>) => ValueRef<State>;
  readonly until:
    | ((context: { readonly output: ValueRef<State> }) => ValueRef<boolean>)
    | ValidatedRepeatCondition<State>;
  readonly maximumIterations: number;
}

interface RepeatBodyContext<State> {
  readonly input: ValueRef<State>;
  readonly task: <TaskInput, TaskOutput>(
    definition: TaskDefinition<TaskInput, TaskOutput>,
    options: { readonly input: InputBinding<TaskInput> },
  ) => TaskInvocation<TaskOutput>;
  readonly validate: <Candidate>(
    validator: Validator<Candidate>,
    options: { readonly input: InputBinding<Candidate> },
  ) => ValidationInvocation<Candidate>;
}
```

Exactly one `until` value must be provided. A function retains the existing
boolean behavior. `validatedBy(validator)` accepts the same `Validator` used
by normal gates and lowers to final repeat-body check nodes plus a
repeat-postcondition gate:

- `success: true` stops the repeat and returns the candidate;
- `success: false` starts the next iteration with the candidate state;
- a malformed validator result fails the Run;
- exhaustion raises `LoopLimitExceededError` and includes the latest issues and
  evidence.

The postcondition gate is the final body node. No body node may depend on its
result. This keeps “failed validation” from silently allowing same-iteration
work after the acceptance point.

To validate only the final repeat result, call normal `validate` after
`.repeat()`.

## 6. Plan IR

Separate validation computation from continuation policy. A check always
produces a verdict. A gate consumes exactly one check verdict and applies a
policy. This keeps mechanical/evaluator strategies composable with normal
gates and repeat postconditions.

Add these Seqlane-owned nodes:

```ts
export type ValidationSource =
  | { readonly type: "mechanical"; readonly validatorId: string }
  | { readonly type: "task"; readonly taskId: TaskId };

export interface ValidationCheckNode {
  readonly type: "validation.check";
  readonly nodeId: PlanNodeId;
  readonly source: ValidationSource;
  readonly input: ValueBinding;
  readonly dependsOn: readonly PlanNodeId[];
}

export type ValidationGatePolicy = "fail" | "repeat-postcondition";

export interface ValidationGateNode {
  readonly type: "validation.gate";
  readonly nodeId: PlanNodeId;
  readonly input: ValueBinding;
  readonly checkNodeId: PlanNodeId;
  readonly policy: ValidationGatePolicy;
  readonly dependsOn: readonly PlanNodeId[];
}

export type ValidationNode = ValidationCheckNode | ValidationGateNode;

export type PlanNode = TaskNode | ValidationNode | RepeatNode;
```

`RepeatBodyPlan.nodes` becomes `readonly (TaskNode | ValidationNode)[]`.
Each `Validator` lowers to one `ValidationCheckNode` plus one
`ValidationGateNode`. The gate's `checkNodeId` references its check.

`ValidationInvocation.output` serializes as a reference to the gate's
candidate path, and `ValidationInvocation.result` serializes as a reference
to the gate's verdict path. The runtime value is an internal envelope:

```ts
{
  value: Candidate,
  validation: ValidationResult,
}
```

The envelope is never exposed as an untyped public result. The authoring
handles select its two typed paths.

The Plan contains only source identities, gate policy, bindings, and
dependencies. Mechanical callbacks remain in the separately returned
validator registry, like task definitions remain outside the serialized Plan.
Evaluator task definitions remain in the task definition registry.

`buildWorkflow` returns:

```ts
interface BuiltWorkflow<Input, Output> {
  readonly workflow: WorkflowDefinition<Input, Output>;
  readonly plan: Plan;
  readonly taskDefinitions: TaskDefinitionRegistry;
  readonly validatorDefinitions: ValidatorDefinitionRegistry;
}
```

## 7. Plan Validation

Extend `validatePlan` with these checks:

- validation node IDs are unique and non-empty;
- check source type is `mechanical` or `task` with a non-empty identity;
- gate policy is `fail` or `repeat-postcondition`;
- every gate references exactly one check node;
- every gate check reference targets a validation check node and is listed in
  `dependsOn`;
- every input reference targets an existing node or workflow input;
- every input reference is listed in `dependsOn`;
- validation nodes have no self-dependency;
- a `repeat-postcondition` gate appears only in a repeat body;
- the postcondition gate is the final body node;
- the postcondition gate's `checkNodeId` is body-local;
- the repeat body's `until` references the postcondition gate's
  `validation.success` field after lowering;
- a `fail` gate cannot be used as a repeat condition;
- repeat-body references stay inside the body or target its state input; and
- the complete outer and nested graphs remain acyclic.

Plan validation does not execute validators or require a runtime registry.
Missing registry entries fail during runtime preparation before task execution.

## 8. Registry and Runtime Plumbing

Extend `CompileWorkflowOptions` and `ExecutionContextOptions` with the
validator registry. The workflow loader passes `BuiltWorkflow`'s registry to
the runner execution factory. Task-level `validateOutput` uses the same
registry path as explicit validation. Package boundaries remain unchanged:

- `seqlane-core` owns contracts, Plan nodes, definitions, and authoring;
- `seqlane-runtime` resolves mechanical validators and evaluator tasks;
- private executor adapters execute evaluator tasks;
- no executor identity is serialized into a Plan.

Runtime execution for validation nodes:

1. Resolve and consume the check input binding.
2. Parse the input with the mechanical validator schema or evaluator task
   input schema.
3. Execute the mechanical callback or evaluator task and store its
   `ValidationResult`.
4. Store the internal `{ value, validation }` envelope at the gate.
5. Emit check and gate lifecycle events.
6. For `fail`, throw on `success: false` before any dependent node starts.
7. For `repeat-postcondition`, return the boolean verdict to repeat control.

Mechanical validator callbacks must be synchronous, read-only, and invoked
once per check execution. Evaluator tasks used as validators must be read-only
and follow the existing one-attempt, cancellation, input-schema, executor, and
output-schema lifecycle.

Malformed mechanical results are `RuntimeError`s. Malformed evaluator results
are `OutputValidationError`s for the evaluator task. A well-formed failed gate
is a new `ValidationError` with the validation node identity, source identity,
issues, and bounded evidence.

Add:

```ts
export class ValidationFailedError extends SeqlaneError {
  readonly nodeId: PlanNodeId;
  readonly sourceId: string;
  readonly issues: readonly ValidationIssue[];
  readonly evidence?: JsonValue;
}
```

Add `"ValidationError"` to `SeqlaneErrorCategory`. The class name is
`ValidationFailedError`; the serialized/category name is `ValidationError`.
Duplicate validator IDs fail during workflow build. Missing validator IDs fail
during runtime preparation. Do not add retry logic.

## 9. Events and Runner Protocol

Add `"validation"` to `SeqlaneInvocationKind`. Reuse the existing
invocation lifecycle; do not add a second event family.

Use a discriminated invocation subject instead of overloading `taskId`:

```ts
export type SeqlaneInvocationSubject =
  | { readonly type: "task"; readonly taskId: TaskId }
  | { readonly type: "validator"; readonly validatorId: string }
  | { readonly type: "validation-gate"; readonly planNodeId: PlanNodeId };
```

`invocation.created` and `invocation.started` carry `subject`. The existing
`taskId` field becomes optional compatibility data and is present only for a
task subject. Mechanical validator IDs never appear in `taskId`.

For a validation invocation:

- `invocation.created.kind` is `"validation"`;
- check invocations use a `validator` subject or a `task` subject;
- gate invocations use a `validation-gate` subject;
- `invocation.input` contains the candidate under existing display policy;
- `invocation.result` contains the `ValidationResult` under existing display
  policy;
- `invocation.succeeded` means the validation operation executed and, for a
  gate, passed;
- a failed gate emits `invocation.failed` with `ValidationError` and then
  `run.failed`; and
- a failed repeat postcondition emits `invocation.succeeded` with a false
  result and lets repeat control continue.

Extend serialized errors with bounded validation details:

```ts
interface SerializedValidationFailure {
  readonly validationNodeId: PlanNodeId;
  readonly sourceId: string;
  readonly issues: readonly ValidationIssue[];
  readonly evidence?: SeqlaneDisplayValue;
}
```

Runner and Studio must apply existing redaction, truncation, and omission
rules. They must not forward raw evaluator prompts, model objects, or private
executor errors. Validator evidence uses the existing display policy by
default; raw evidence is never forwarded without an explicit display
selection.

## 10. Result Lifetime and Replay

The validation envelope follows the existing remaining-consumer accounting.
The candidate and verdict remain until their final `ValueRef` consumer and
then are released together. Repeat execution retains only the current state,
the active body values, and the latest postcondition verdict.

Mechanical validators are deterministic by contract. Evaluator tasks are not
assumed deterministic. V1 does not cache or replay evaluator decisions. A
rerun executes the evaluator again. The event stream records the input,
result, task/validator identity, and normal invocation metadata. Authors who
need versioned evaluator behavior must version the task or workflow identity.

## 11. Tests

Add core tests for:

- `ValidationResult` type contracts and JSON serialization;
- validator definition and registry collection;
- typed Flow handles for candidate and verdict;
- direct mechanical definitions and evaluator tasks through `validate`;
- task-level `validateOutput` lowering and validated task handles;
- deterministic node IDs and dependency extraction; and
- `validatedBy` repeat postcondition lowering and invalid combinations;
- duplicate validator IDs and compile-time literal/unique Flow names.

Add runtime tests for:

- mechanical pass and fail;
- evaluator-task pass, semantic fail, malformed output, and executor fail;
- no dependent execution after a failed gate;
- evidence and issue propagation through `SeqlaneRunOutcome`;
- cancellation during evaluator execution;
- repeat postcondition pass on iteration one;
- repeat postcondition failure followed by a later pass;
- repeat postcondition exhaustion with latest evidence;
- validation result and candidate release after final consumers; and
- missing registry entries before any task execution.

Add runner/output tests for:

- validation invocation kind and lifecycle ordering;
- distinct task, validator, and validation-gate subjects;
- serialized `ValidationError` details;
- redacted, truncated, and omitted evidence;
- Studio display of validation verdicts; and
- unchanged autonomous/non-interactive behavior.

Tests use deterministic validators and fake evaluator executors. No live model,
real repository, human approval, or external service is required.

## 12. Acceptance Criteria

TS-015 is complete when:

- authors can gate a task or repeat result with a mechanical validator;
- authors can gate a result with a dedicated evaluator task;
- authors can validate a task output through the task-level `validateOutput`
  option without creating a separate public gate handle;
- a prompt-backed evaluator remains an ordinary executor-neutral Seqlane task;
- a false gate result prevents dependent work and fails the Run;
- a repeat can converge on a validated postcondition within its bound;
- validation issues and bounded evidence reach outcomes and output consumers;
- Plans contain no callbacks, Mastra types, executor objects, or model clients;
- validation invocations are visible in existing event and Studio projections;
- cancellation, schema validation, and no-retry behavior remain unchanged; and
- all core, runtime, runner, output, typecheck, format, and sync checks pass.

## 13. Explicitly Deferred

TS-015 does not implement:

- automatic retry or producer feedback;
- recovery branches or general conditional branching;
- human approval or interactive validation;
- a composable validator language (`all`, `any`, `none`, `not`, quorum, or
  custom rule expressions); this requires a dedicated ADR and technical spec;
- persistent verdict caches or evaluator replay;
- parallel repeat iterations;
- a prompt-specific public API in `seqlane-core`.

## 14. Delivery Order

1. Add core validation contracts, Plan nodes, registry collection, and errors.
2. Add direct validator/evaluator authoring and task-level `validateOutput`.
3. Add unified `until`/`validatedBy` repeat lowering and Plan validation.
4. Add runtime mechanical/evaluator execution and failure semantics.
5. Extend lifecycle, runner protocol, output, and Studio projections.
6. Add fixtures and representative workflow coverage.
7. Run full typecheck, tests, build, format, and Nx sync checks.

## 15. References

- [ADR-015 — Semantic Validation Gates](ADR-015-semantic-validation-gates.md)
- [ADR-003 — Seqlane Plan IR and Typed Dataflow](ADR-003-seqlane-plan-ir-and-typed-dataflow.md)
- [ADR-005 — Autonomous Non-Interactive Execution](ADR-005-autonomous-non-interactive-execution.md)
- [ADR-008 — Executor-Neutral Workflow Authoring](ADR-008-executor-neutral-workflow-authoring.md)
- [ADR-012 — Fluent Seqlane Flow DSL](ADR-012-fluent-seqlane-flow-dsl.md)
