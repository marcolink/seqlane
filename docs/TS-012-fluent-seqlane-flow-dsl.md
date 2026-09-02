# TS-012 — Fluent Seqlane Flow DSL and Conditioned Repeat

**Status:** In progress
**Implements:** ADR-012
**Depends on:** ADR-001, ADR-003, ADR-006, ADR-008, TS-003
**Scope:** MVP

## Objective

Deliver a typed, fluent Seqlane authoring API. The API builds the existing
Seqlane-owned Plan IR. It adds one structured control-flow node: a bounded,
post-condition repeat.

The public API remains executor-neutral. The runtime owns repeat execution and
uses Mastra only behind the existing private compiler boundary.

The MVP has one public task model: an agent-oriented `TaskDefinition` created
with `defineTask`. `goal` is the task objective; `instructions` are static
behavioral constraints; `references` are supporting context. Prompt, GitHub,
provider, and executor-specific task types are out of scope. Future non-agent
work must extend the shared Seqlane task contract rather than add provider
types to core.

## Invariants

- `@seqlane/core` owns Flow DSL and `RepeatNode` contracts.
- Core exports no Mastra, executor, process, or runtime callback types.
- `createFlow(...).define()` returns a normal `WorkflowDefinition`.
- `defineWorkflow` and `buildWorkflow` remain supported.
- Task and repeat names are unique string literals.
- A name is an authoring alias. It does not change a Task ID, Plan-node ID, or
  runtime Invocation ID.
- The authoring `tasks` object contains typed output handles only. It never
  contains runtime values.
- Task-output references remain the only source of ordinary DAG dependencies.
- A repeat body is a static, serializable Seqlane subplan.
- A repeat runs its body at least once and at most `maximumIterations` times.
- Repeat iterations are sequential.
- A repeat condition is a `ValueRef<boolean>` from the body result. Seqlane
  does not store or execute a JavaScript predicate.
- The runtime retains a result only until its final consumer and final-output
  use complete.
- A repeat retains only current state, active body results, and its final
  result for execution.
- Plan construction never executes task work or an executor callback.
- The MVP does not expose separate prompt, GitHub, or operation task types.

## Public Authoring Contract

### Flow builder

`createFlow` accepts workflow identity, input schema, and output schema. It
returns a builder whose generic state records each earlier named handle.

```ts
const flow = createFlow({
  id: "repository-report",
  input: repositoryReportInputSchema,
  output: repositoryReportOutputSchema,
});
```

The builder exposes these operations:

```ts
flow.task(name, definition, binding);
flow.repeat(name, options);
flow.output(binding).define();
```

`name` must be a string literal. The public type rejects a widened `string`.
It also rejects a name already present in the builder state.

The exact public type shape is:

```ts
interface FlowHandle<Output> {
  readonly output: ValueRef<Output>;
}

interface FlowAuthoringContext<Input, Handles> {
  readonly input: ValueRef<Input>;
  readonly tasks: Handles;
}

type FlowBinding<Input, Handles, Target> =
  | InputBinding<Target>
  | ((context: FlowAuthoringContext<Input, Handles>) => InputBinding<Target>);
```

`.task()` extends `Handles` with `Record<Name, FlowHandle<Output>>`. A later
binding can access `tasks[name].output`. An unknown name is a TypeScript error.

The callback receives only handles declared before that call. This prevents
forward references and cycles in normal task wiring.

`.output()` accepts `InputBinding<WorkflowOutput>` or a binding callback. It
returns a completed builder. The completed builder exposes `.define()` only.

`.define()` creates a `WorkflowDefinition`. Its internal `build` callback
replays the stored Flow declarations through the existing `run` mechanism.
The Flow DSL does not create a second executable workflow representation.

### Repeat builder

`.repeat()` adds a named `FlowHandle<State>` to later `tasks` contexts. It uses
the following contract:

```ts
interface RepeatOptions<OuterInput, OuterHandles, State> {
  readonly initial: FlowBinding<OuterInput, OuterHandles, State>;
  readonly body: (context: RepeatBodyContext<State>) => ValueRef<State>;
  readonly until: (context: { readonly output: ValueRef<State> }) => ValueRef<boolean>;
  readonly maximumIterations: number;
}

interface RepeatBodyContext<State> {
  readonly input: ValueRef<State>;
  readonly task: <TaskInput, TaskOutput>(
    definition: TaskDefinition<TaskInput, TaskOutput>,
    options: { readonly input: InputBinding<TaskInput> },
  ) => TaskInvocation<TaskOutput>;
}
```

`initial` supplies state for iteration 1. Each later iteration receives the
previous body output. The body output and initial value have the same static
type, `State`.

The repeat body has access to its state and local `task` function only. It
cannot reference outer task handles directly. An author passes required outer
data through `initial`.

V1 does not allow a nested `.repeat()` in a repeat body. It also excludes
`parallel`, `branch`, and `foreach` builders.

The example below shows a valid repeat. `RepairState` is both the initial and
body-output type.

```ts
const repairWorkflow = createFlow({
  id: "repair-until-verified",
  input: repairInputSchema,
  output: repairStateSchema,
})
  .repeat("repair", {
    initial: ({ input }) => ({
      repository: input.repository,
      passed: false,
    }),
    body: ({ input, task }) => {
      const change = task(applyRepairTask, { input });
      const verification = task(verifyRepairTask, {
        input: {
          repository: input.repository,
          change: change.output,
        },
      });

      return verification.output;
    },
    until: ({ output }) => output.passed,
    maximumIterations: 3,
  })
  .output(({ tasks }) => tasks.repair.output)
  .define();
```

## Plan Contract

### Node types

Extend the Plan union in core:

```ts
type PlanNode = TaskNode | RepeatNode;

interface RepeatNode {
  readonly type: "repeat";
  readonly nodeId: PlanNodeId;
  readonly input: ValueBinding;
  readonly dependsOn: readonly PlanNodeId[];
  readonly maximumIterations: number;
  readonly body: RepeatBodyPlan;
}

interface RepeatBodyPlan {
  readonly inputNodeId: PlanNodeId;
  readonly nodes: readonly TaskNode[];
  readonly output: ValueBinding;
  readonly until: ValueRef<boolean>;
}
```

`RepeatNode.input` contains the initial state binding. `RepeatBodyPlan` uses
its local `inputNodeId` as the current-state reference. The body output is the
next state and the repeat output.

The builder assigns deterministic addresses in declaration order:

- top-level task nodes keep the existing `<task-id>:<count>` format;
- repeat nodes use `repeat:<count>`;
- a body input node uses `<repeat-node-id>:input`;
- body task nodes use `<repeat-node-id>/<task-id>:<count>`.

These addresses are Plan-local. Runtime invocation IDs remain generated per
run. The authoring alias does not appear in the serialized Plan.

### Validation

Extend `validatePlan` to validate the outer graph and every repeat body.

- `RepeatNode.nodeId` must be unique across the full Plan tree.
- The outer `input` binding may reference workflow input or earlier outer
  nodes. Its referenced outer nodes must appear in `dependsOn`.
- `maximumIterations` must be a finite positive integer.
- A body must contain at least one task node.
- Body task IDs must be unique in their repeat scope after node ID allocation.
- Body bindings may reference the body input or earlier body task nodes only.
- `body.output` must reference the body input or a body task node.
- `until` must be a reference into `body.output` or a body task result. It must
  not be a literal, an outer reference, or a workflow-input reference.
- The body graph must not contain a dependency cycle.
- The existing duplicate, missing-reference, reference-path, and dependency
  checks apply in both scopes.

The compiler cannot prove the runtime boolean value. The Flow DSL type system
requires `ValueRef<boolean>`. Runtime task-output schema validation remains the
authority for the referenced value.

## Runtime Contract

### Repeat execution

The runtime lowers each `RepeatNode` behind the private Mastra boundary. The
public Plan does not contain Mastra control-flow objects or callbacks.

The repeat mechanism follows this sequence:

1. Resolve and validate the initial state.
2. Execute the static body tasks in their dependency order.
3. Resolve the body output as the current state.
4. Resolve the `until` reference from that state.
5. If the condition is `true`, publish the current state as the repeat result.
6. If the condition is `false` and attempts remain, use the current state for
   the next iteration.
7. If the condition is `false` on the final attempt, fail the run.

`maximumIterations` is the maximum number of body executions. A value of `3`
permits at most three body executions.

Task input and output schemas validate every body task on every iteration.
Task cancellation aborts the active body task and the repeat. Existing task
failure behavior ends the repeat and fails the run. V1 adds no repeat retry
policy.

### Loop-limit error

Add `LoopLimitExceededError` to core. It extends `SeqlaneError` with category
`RuntimeError` and includes the repeat Plan-node ID and `maximumIterations`.
The runner serializes this error through the existing Seqlane error protocol.

### Events and identities

Extend `SeqlaneInvocationKind` with `"loop"`.

The runtime emits one `invocation.created` event for each repeat node. It uses
kind `"loop"`. The runtime emits a dynamic `invocation.created` event for each
body task invocation. Each body event has the loop invocation as its parent.

Add optional `iteration: number` to task invocation lifecycle events. The
runtime sets it to `1` for the first body execution. The runtime does not set
it for ordinary top-level tasks or the loop node.

Body invocation IDs are unique for every iteration. Their Plan-node ID remains
the static body address. The output package renders loop children under their
loop invocation and retains the stated stable order.

### Result lifetime

Before execution, the runtime computes each node's remaining consumer count.
A consumer is a task input or the final Plan output. Multiple references in
one task input count as one consumer.

After a task input resolves, the runtime decrements the count for every source
node consumed by that task. The runtime removes a result when its count becomes
zero. It retains a final-output source until final output resolution.

For each repeat iteration, the runtime computes body consumer counts. It
releases body values after their final body consumer. It retains only the body
output as the next state. It releases previous state after the next state is
available. It releases all active body values when the repeat completes or
fails.

Event summaries are produced before result release. Persistent output storage,
when later introduced, owns its values outside the execution-context result
map.

## Compatibility and Migration

- `defineWorkflow`, `buildWorkflow`, direct `Plan` input, and Plan factories
  remain supported.
- Existing task-only Plans retain their current serialized form and runtime
  behavior.
- The runner protocol receives no new command or request field.
- Runner event validation, output reduction, and renderers accept loop events
  and the optional iteration field.
- Update core and runtime READMEs with Flow DSL and repeat examples.
- Migrate the built-in example workflow to Flow DSL after core contract tests
  prove compatibility.

## Test Contract

### Compile-time tests

- A literal task name creates the exact key on `tasks`.
- An unknown, duplicate, or widened task name fails type checking.
- A task binding accepts compatible literals, workflow input, and prior handle
  output references.
- A repeat initial binding and body result must share one state type.
- A repeat condition must be `ValueRef<boolean>`.
- A repeat handle is available to later task bindings and `.output()`.
- A body cannot access outer handles or declare nested repeat control flow.
- A representative large flow type-checks within the repository test budget.

### Core and runtime tests

- A Flow DSL definition produces the expected task-only Plan from ADR-012.
- Authoring aliases do not occur in the serialized Plan.
- Every supported connection type produces the expected dependency edges.
- A valid repeat serializes and validates with deterministic node addresses.
- Plan validation rejects invalid limits, invalid scopes, empty bodies, cycles,
  and invalid condition references.
- A repeat succeeds on the first iteration.
- A repeat succeeds on its final permitted iteration.
- A repeat fails with `LoopLimitExceededError` after its final permitted
  iteration.
- A body task input, task output, cancellation, or executor failure ends the
  repeat and produces the existing normalized run failure.
- Loop events have parent, iteration, unique invocation ID, and stable order.
- Result lifetime releases a DAG result after its final consumer.
- Result lifetime retains a final-output value until final output resolution.
- A repeat retains no prior body output after the next iteration starts.
- Core, Plan, runner IPC, fixtures, and public documentation remain free of
  Mastra and executor details.

## Out of Scope

- `parallel`, `branch`, `foreach`, dynamic scheduling, and nested repeat.
- Nested workflow invocation through the Flow DSL.
- Public Mastra APIs, state, suspension, resumption, or persistence.
- Executor selection, executor configuration, and executor-specific metadata.
- Repeat-level retry or repair policy.
- Persistent workflow history or replay.
- Changes to the CLI command/request protocol.

## Delivery Order

1. Add Flow builder contracts and compile-time tests in core.
2. Lower Flow builder declarations through existing `WorkflowDefinition` and
   validate task-only compatibility.
3. Add `RepeatNode` construction and recursive Plan validation.
4. Add repeat lowering, task execution, cancellation, error, and liveness
   handling in the private runtime.
5. Add loop event contracts and output rendering.
6. Migrate examples and update mutable package documentation.

## Sources

- [ADR-012 — Fluent Seqlane Flow DSL](ADR-012-fluent-seqlane-flow-dsl.md)
- [ADR-001 — Internal workflow engine](ADR-001-mastra-internal-workflow-engine.md)
- [ADR-003 — Plan IR and typed dataflow](ADR-003-seqlane-plan-ir-and-typed-dataflow.md)
- [ADR-006 — Repository and user composition](ADR-006-repository-user-workflow-discovery-and-composition.md)
- [ADR-008 — Executor-neutral authoring](ADR-008-executor-neutral-workflow-authoring.md)
- [TS-003 — Plan IR and typed dataflow](TS-003-seqlane-plan-ir-typed-dataflow.md)
- [RFC-001 — Seqlane technical architecture](RFC-001-seqlane-technical-architecture.md)
