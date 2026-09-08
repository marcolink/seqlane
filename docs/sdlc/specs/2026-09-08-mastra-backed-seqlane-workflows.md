---
id: spec.mastra-backed-seqlane-workflows
title: Mastra-Backed Seqlane Workflow Contracts
status: active
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - adr.mastra-backed-seqlane-workflows
supersedes:
  - spec.effect-runtime-integration
  - spec.fluent-seqlane-flow-dsl
  - spec.executor-neutral-workflow-authoring
  - spec.seqlane-plan-ir-typed-dataflow
  - spec.consumer-agnostic-seqlane-execution-events
---

# Mastra-Backed Seqlane Workflow Contracts

## Summary

This specification defines the authoring, Plan, compilation, and migration
contracts for Mastra-backed Seqlane workflows. It replaces the active specs
for the Effect runtime, fluent DSL, executor-neutral authoring, Plan IR, and
consumer-agnostic events.

## Goals

- Provide one public task and workflow contract.
- Compile a Seqlane-owned Plan to Mastra at a private runtime boundary.
- Preserve typed inputs, outputs, validation, session policy, workspace policy,
  admission, cancellation, cleanup, and serial behavior.
- Preserve CLI, output, Studio, recording, replay, runner, and typed outcome
  behavior during migration.
- Move observability to Mastra with Seqlane semantic attributes.

## Non-goals

- Adding a second workflow engine.
- Exposing Mastra types from `@seqlane/core` or public authoring APIs.
- Adding branch, choose, parallel, foreach, retries, suspend or resume,
  persistence, or generic conditional nodes.
- Selecting a final concurrent DAG execution model.
- Deleting Studio, recording, or replay.
- Redefining active session, model, local-task, admission, or runner policy.

## Terminology

- **Task**: A typed executable unit with a Zod input schema, a Zod output
  schema, and an `execute` function.
- **Workflow**: A named runnable that contains task or workflow invocations.
- **Runnable**: A value that the task and workflow invocation APIs can accept.
- **Plan**: The small serializable Seqlane representation produced by authoring.
- **Compiler**: The private runtime adapter that maps a Plan to Mastra.
- **Eligibility**: The Mastra graph state that permits a node to be visited.
- **Admission**: The Seqlane policy decision that permits work to start.
- **Invocation**: One runtime execution of a task or workflow node.
- **Run outcome**: A typed success, error, cancellation, or rejection result.

## Requirements

### REQ-TASK-001: Use one executable task contract

`defineTask` must require `id`, `input`, `output`, and `execute`. The input and
output fields must be Zod schemas. The public type must infer input and output
types from those schemas.

`defineAgentTask` and `defineShellTask` must return the same task contract.
Each specialized factory must provide its own `execute` implementation. A
caller must not pass `execute` to a specialized factory.

Specialized factories must express Seqlane capabilities. They must not expose
Mastra, OpenCode, provider, client, connection, or other executor product
types.

The foundational execution shape is:

```ts
type TaskExecute<InputSchema extends z.ZodType, OutputSchema extends z.ZodType> =
  (request: {
    readonly input: z.output<InputSchema>;
    readonly signal: AbortSignal;
  }) => Promise<z.input<OutputSchema>>;
```

The runtime parses input before `execute`. It parses the returned value with
the output schema. The successful task result has type
`z.output<OutputSchema>`.

A specialized return type can carry Seqlane capability metadata for policy
validation. This metadata must not select or configure an executor product.

### REQ-TASK-002: Use one workflow authoring API

The public workflow API must use `createFlow(...).task(...).output(...).define()`.
The API must not support `defineWorkflow({ build })`.

The API must infer dependencies from references and explicit invocation data.
Declaration order alone must not create a dependency.

### REQ-TASK-003: Treat workflows as runnables

Every location that accepts a task or runnable must accept a workflow. A
workflow invocation must have a typed input and output contract. Nested
workflow invocations must retain node identity and input binding information.

### REQ-PLAN-001: Keep a small Seqlane Plan boundary

The Plan must be serializable and independent of Mastra and Effect. Authors
must receive a workflow or runnable; they must not hand-build a Plan.

The final Plan must contain only task invocation, workflow invocation,
validation check, validation gate, and bounded repeat nodes. A registry must
resolve runnable references without placing executable functions in serialized
data.

### REQ-PLAN-002: Validate Plan data at runtime

Zod schemas must define Plan nodes, bindings, and serialized run data. The
runtime must validate registry keys and each referenced definition with its
owning schema. Malformed data must produce typed errors. The runtime must not
use unchecked JSON parsing or handwritten type predicates.

### REQ-POLICY-001: Apply policy after eligibility

Mastra graph eligibility must identify nodes that can proceed. Seqlane must
apply session and workspace policy before execution starts. Admission must stay
atomic across all resources that the invocation needs.

Admission wait after dependencies become ready must be observable. Session
reuse, branching, ordering, and workspace identity must follow the active
policy and session specifications.

All runnable invocations can declare workspace policy. Only a session-capable
task invocation can declare session policy. A nested workflow retains its
internal policies and does not receive a synthetic session.

### REQ-RUNTIME-001: Compile behind a private boundary

The compiler must accept a validated Seqlane Plan and produce a private Mastra
workflow. Mastra types must remain inside runtime or adapter packages.

The compiler must reuse the invocation kernel. It must preserve typed outcomes,
cancellation, process cleanup, policy failures, and deterministic node identity.

The initial compiler must preserve serial observable behavior. It must not add
concurrent starts as an incidental result of Mastra graph construction.

### REQ-RUNTIME-002: Remove Effect

Effect packages, imports, runtime modules, and Effect-based subprocess
execution must be removed. Subprocess execution must preserve cancellation,
bounded output, process cleanup, and typed errors in its replacement.

### REQ-OBS-001: Preserve semantic observability

Mastra observability must include Seqlane work, run, invocation, Plan node,
workflow, task, session, workspace, admission, outcome, and error attributes
when those values exist. The implementation must not expose Mastra as a public
event contract.

### REQ-OBS-002: Migrate runner and event consumers

Runner notifications must stay narrow. Typed run outcomes must remain available
for IPC and UI consumers. `@seqlane/events` is transitional and remains until
all consumers migrate. The final deletion must leave no consumer or package
reference.

### REQ-COMPAT-001: Preserve current user-visible behavior

The migration must preserve current CLI output, output projections, Studio
behavior, recording, replay, cancellation, and error classification. A change
to one of these behaviors requires a separate decision and test.

## Detailed design or contracts

### Illustrative TypeScript API

The following shapes illustrate the public boundary. They are not a request to
expose a runtime engine type.

```ts
const customTask = defineTask({
  id: "custom-review",
  input: z.object({ change: z.string() }),
  output: z.object({ summary: z.string() }),
  execute: async ({ input }) => ({ summary: input.change }),
});

const agentTask = defineAgentTask({
  id: "inspect-change",
  input: z.object({ prompt: z.string() }),
  output: z.object({ text: z.string() }),
  goal: ({ prompt }) => `Inspect: ${prompt}`,
});

const shellTask = defineShellTask({
  id: "format-change",
  input: z.object({ command: z.string() }),
  output: z.object({ code: z.number() }),
  command: ({ input }) => input.command,
});

const review = createFlow({
  id: "review",
  input: z.object({ prompt: z.string() }),
  output: z.object({ code: z.number() }),
})
  .task("inspect", agentTask, ({ input }) => ({ prompt: input.prompt }), {
    session: { type: "isolated" },
    workspace: "shared",
  })
  .task("format", shellTask, ({ tasks }) => ({
    command: `format ${tasks.inspect.output.text}`,
  }))
  .output(({ tasks }) => tasks.format.output)
  .define();

const parent = createFlow({
  id: "parent",
  input: z.object({ prompt: z.string() }),
  output: z.object({ code: z.number() }),
})
  .task("child", review, ({ input }) => ({ prompt: input.prompt }))
  .output(({ tasks }) => tasks.child.output)
  .define();
```

The examples omit secondary optional fields. The following rules are
normative:

- `defineTask` requires `execute`.
- Specialized factories supply `execute` and reject a caller-supplied one.
- Zod schemas are the source of truth.
- `workflow` and `task` values share the runnable boundary.
- `defineWorkflow({ build })` is not supported.
- Invocation policy remains Seqlane-owned and explicit at the flow boundary.

### Plan node and registry boundary

The Plan contains serializable descriptors and bindings. A registry maps stable
task and workflow keys to executable definitions at runtime. The registry is
not serialized. The compiler reads the registry while it creates Mastra steps.

The node union has these conceptual forms:

```ts
type PlanNode =
  | TaskInvocationNode
  | WorkflowInvocationNode
  | ValidationCheckNode
  | ValidationGateNode
  | BoundedRepeatNode;
```

The implementation must keep node addresses separate from invocation
identities. The Plan records dependencies and bindings. Runtime state records
attempt, session, workspace, admission, outcome, and error data.

### Policy ordering

The runtime applies this sequence:

1. Validate the workflow, registry, Plan, input, and active policy.
2. Compile the Plan to a private Mastra graph.
3. Let Mastra establish graph eligibility.
4. Report eligibility and wait for Seqlane admission when policy blocks start.
5. Acquire session and workspace resources atomically.
6. Invoke the task through the shared invocation kernel.
7. Release resources and publish the typed outcome.

Mastra must not bypass steps four or five. The sequence preserves session reuse,
branching, workspace coordination, and ordered shared-session work.

### Mastra compilation and cutover

The compiler translates each supported Plan node to the smallest Mastra step
that preserves Seqlane identity and bindings. It adapts Mastra lifecycle
signals into Seqlane run outcomes and semantic observability.

The cutover first runs existing serial fixtures through the compiler. It then
removes the Effect runner and its packages. The compiler must not retain an
Effect compatibility path after cutover.

### Workflow composition

A workflow is a runnable with input and output schemas. A parent Plan records a
workflow invocation node and the child workflow key. The runtime compiles the
child workflow through the same private compiler boundary and carries parent
identity into the child invocation.

### Observability and runner notification migration

Mastra spans and events carry Seqlane semantic attributes. The implementation
must record time spent waiting for admission after dependencies become ready.
Runner notifications remain narrow and serializable. Consumers use typed run
outcomes for IPC and UI decisions. Existing `@seqlane/events` consumers move
before the package is deleted.

## Failure and edge cases

- Reject a task definition that lacks required schemas or `execute`.
- Reject a specialized factory call that supplies `execute`.
- Reject malformed Plan nodes, bindings, registry entries, and inputs.
- Reject unsupported node kinds before Mastra execution.
- Report policy denial before task execution starts.
- Release every acquired resource after success, error, cancellation, or
  uncertain subprocess termination.
- Preserve the original cause in typed domain errors.
- Bound subprocess output and terminate the process group during cancellation.
- Do not emit a start event before admission succeeds.
- Keep an unresolved invocation active when cancellation leaves its outcome
  uncertain.

## Migration

Implement the slices in this order:

1. Unify the executable task contract.
2. Unify flow authoring and the minimal Plan.
3. Replace Effect subprocess execution.
4. Add the private Mastra Plan compiler.
5. Cut over the runtime to Mastra and remove Effect.
6. Compose workflows as runnables.
7. Add Mastra observability.
8. Migrate execution-event consumers.
9. Remove `@seqlane/events`.

Each slice remains independently committable. The cutover and final event
deletion use repository-wide verification. Other slices use mapped, focused
Nx targets.

## Verification

Every implementation slice starts with `pnpm test:mapping`. Focused checks use
the existing Nx targets, including `seqlane-core`, `seqlane-runtime`,
`seqlane-events`, `seqlane-output`, `seqlane-opencode`, `seqlane-cli`, and
`seqlane-studio`.

The Mastra cutover and final event deletion also run `pnpm run test`,
`pnpm run typecheck`, and `pnpm run lint`. Documentation changes run
`pnpm docs:index` and `pnpm docs:validate`.

## Acceptance criteria

- Public authors use one task contract and one flow API.
- Specialized factories provide `execute` and use inferred Zod types.
- Workflows compose anywhere a runnable is accepted.
- The Plan is serializable, small, private to Seqlane, and Mastra-independent.
- The compiler supports only the required node set.
- Mastra is the only workflow engine.
- Effect packages and code are absent after cutover.
- Admission remains Seqlane-owned and atomic after Mastra eligibility.
- Serial observable behavior remains compatible.
- Cancellation, bounded output, cleanup, and typed errors remain covered.
- Mastra observability includes Seqlane semantic attributes and admission wait.
- Runner and UI consumers retain narrow notifications and typed outcomes.
- `@seqlane/events` is removed only after its consumers migrate.
- CLI, output, Studio, recording, and replay behavior remains available.
- All nine task slices have completed verification and traceability.

## Traceability

- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [spec.invocation-admission-and-workspace-coordination: Invocation Admission and Workspace Coordination](./2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.session-checkpoint-reuse-and-branching: Session Checkpoint Reuse and Branching](./2026-09-02-session-checkpoint-reuse-and-branching.md)
- [spec.model-selection-and-session-model-semantics: Model Selection and Session Model Semantics](./2026-09-03-model-selection-and-session-model-semantics.md)
- [spec.local-mechanical-tasks: Local Mechanical Tasks](./2026-09-03-local-mechanical-tasks.md)
- [spec.dedicated-runner-process: Dedicated Runner Process and CLI IPC](./2026-09-02-dedicated-runner-process.md)
- [spec.seqlane-execution-output-package: Seqlane Execution Output Package](./2026-09-02-seqlane-execution-output-package.md)
- [spec.local-development-studio-trust-and-lifecycle: Local Development Studio Trust and Lifecycle](./2026-09-02-local-development-studio-trust-and-lifecycle.md)
- [spec.studio-vite-development-and-isolated-replay: Studio Vite Development and Isolated Replay](./2026-09-02-studio-vite-development-and-isolated-replay.md)
- [spec.effect-runtime-integration: Effect Runtime Integration](./2026-09-02-effect-runtime-integration.md)
- [spec.fluent-seqlane-flow-dsl: Fluent Seqlane Flow DSL and Conditioned Repeat](./2026-09-02-fluent-seqlane-flow-dsl.md)
- [spec.executor-neutral-workflow-authoring: Executor-Neutral Workflow Authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.seqlane-plan-ir-typed-dataflow: Seqlane Plan IR and Typed Dataflow](./2026-09-02-seqlane-plan-ir-typed-dataflow.md)
- [spec.consumer-agnostic-seqlane-execution-events: Consumer-Agnostic Seqlane Execution Events](./2026-09-02-consumer-agnostic-seqlane-execution-events.md)
