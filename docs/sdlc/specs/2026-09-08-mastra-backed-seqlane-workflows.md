---
id: spec.mastra-backed-seqlane-workflows
title: Mastra-Backed Seqlane Workflow Contracts
status: active
owners:
  - core
created: 2026-09-08
updated: 2026-09-09
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
contracts for Mastra-backed Seqlane workflows. It replaces the former
Effect-runtime specification and the active fluent DSL, executor-neutral
authoring, Plan IR, and consumer-agnostic event specifications.

## Goals

- Provide one public task and workflow contract.
- Compile a Seqlane-owned Plan to Mastra at a private runtime boundary.
- Preserve typed inputs, outputs, validation, session policy, workspace policy,
  admission, cancellation, cleanup, and current dependency-aware concurrency.
- Preserve CLI, output, Studio, recording, replay, runner, and typed outcome
  behavior during migration.
- Move observability to Mastra with Seqlane semantic attributes.
- Define a versioned runner protocol with strict schemas and one terminal
  serialized outcome for each run.

## Non-goals

- Adding a second workflow engine.
- Exposing Mastra types from `@seqlane/core` or public authoring APIs.
- Adding branch, choose, parallel, foreach, retries, suspend or resume,
  persistence, or generic conditional nodes.
- Adding a new concurrency feature or changing the active admission policy.
- Deleting Studio, recording, or replay.
- Redefining active session, model, local-task, admission, or runner policy.
- Creating a generic replacement event bus or a new public protocol package.

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
- **Runner notification**: A non-terminal, versioned message for runner and UI
  progress.
- **Serialized run outcome**: The one terminal, versioned result for a Run.

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

The Plan must be serializable and independent of Mastra. It must not contain
Effect values or types. Authors
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

Dependencies establish eligibility. Independent eligible nodes can execute
concurrently. Seqlane session and workspace admission determine actual starts.
Completion and notification order for independent work is not deterministic.
The compiler must not add a second scheduling policy.

### REQ-RUNTIME-002: Keep Effect Removed

The active runtime has no Effect packages, imports, modules, or compatibility
paths. PR #17 replaced the former Effect subprocess path with Mastra process
execution. PR #26 removed the remaining Effect orchestration. Subprocess
execution preserves cancellation, bounded output, process cleanup, and typed
errors. A shell task must pass one executable and an argv array to direct spawn with
`shell: false`. Workflow data can populate argv elements, but it must not form
a parsed command string. The runtime owns the canonical workspace, environment
policy, finite process timeout, process-group cleanup, and workspace lease.

### REQ-OBS-001: Preserve semantic observability

Mastra observability must use a canonical bounded projection. It can include
allowlisted work, run, invocation, Plan node, workflow, task, session,
workspace, admission, outcome, and error identifiers, enums, counts, booleans,
and durations when those values exist. It must omit prompts, task inputs and
outputs, credentials, tokens, secrets, headers, filesystem paths, arbitrary
metadata, stack traces, and raw causes. Strings and attribute counts must have
fixed bounds: at most 64 attributes per record, at most 256 UTF-8 bytes per
string value, and at most 1,024 UTF-8 bytes for a sanitized local diagnostic.
Counts must be non-negative safe integers. Durations must be finite,
non-negative numbers. Exporter failure must not change the execution outcome
and can produce only the bounded local diagnostic.

### REQ-OBS-002: Migrate runner and event consumers

Runner notifications must stay narrow and use the versioned runner protocol
defined below. Typed serialized run outcomes must remain available for IPC and
UI consumers. Before a consumer migrates, `@seqlane/events` remains the
canonical serialized event contract for that consumer. Its active consumer
specification remains authoritative for current behavior.

The migration creates the core-owned replacement schemas. It must update each
affected active consumer specification with its implementation change. The
transition ends only when runner, CLI, output, Studio, recording, and replay
compatibility tests pass. The final deletion must leave no consumer or package
reference.

### REQ-RUNNER-001: Own the replacement runner protocol in core

The migration creates strict Zod schemas and inferred types in the
engine-neutral `@seqlane/core` runner-protocol boundary. The current boundary
owns runner commands and references only. `@seqlane/events` owns the current
serialized events until each consumer migrates.

After migration, core owns runner notifications, protocol envelopes,
serialized errors, and serialized run outcomes. The runtime owns emission and
encoding. No Mastra or executor type crosses the boundary. The migration must
not add a generic replacement event bus.

Each Run uses a versioned JSON envelope. The envelope has a protocol version,
the Work and Run identities, a run-local sequence, and exactly one payload.
Sequence values start at 1 and increase by one for every emitted envelope.
The runtime emits notifications before the terminal outcome. It emits exactly
one terminal outcome. It emits no notification after that outcome.

The contract has these conceptual Zod shapes. The implementation must use
strict schemas and derive its public types with `z.infer`.

```ts
const runnerNotificationSchema = z.discriminatedUnion("type", [
  runStartedNotificationSchema,
  invocationStartedNotificationSchema,
  invocationProgressNotificationSchema,
  invocationSucceededNotificationSchema,
  invocationFailedNotificationSchema,
  invocationCancelledNotificationSchema,
  runHeartbeatNotificationSchema,
]);

const serializedRunOutcomeSchema = z.discriminatedUnion("status", [
  runSucceededOutcomeSchema,
  runFailedOutcomeSchema,
  runCancelledOutcomeSchema,
  runUncertainOutcomeSchema,
]);

const runnerEnvelopeSchema = z
  .object({
    protocol: z.literal("seqlane.runner.v1"),
    workId: z.string().min(1),
    runId: z.string().min(1),
    sequence: z.number().int().positive(),
    payload: z.union([
      z.object({ kind: z.literal("notification"), value: runnerNotificationSchema }).strict(),
      z.object({ kind: z.literal("outcome"), value: serializedRunOutcomeSchema }).strict(),
    ]),
  })
  .strict();

type RunnerNotification = z.infer<typeof runnerNotificationSchema>;
type SerializedRunOutcome = z.infer<typeof serializedRunOutcomeSchema>;
type RunnerEnvelope = z.infer<typeof runnerEnvelopeSchema>;
```

The actual schemas must define bounded strings, safe serialized errors, and
the complete field set for each variant. A run outcome is one of `succeeded`,
`failed`, `cancelled`, or `uncertain`. A failed outcome uses a stable error
category and code. Error categories are `protocol`, `validation`, `policy`,
`task`, `subprocess`, `cancellation`, `uncertain-termination`, and `internal`.
The serialized form contains only the category, a stable bounded code, and an
optional sanitized bounded message. It never contains a cause, stack, input,
output, path, prompt, credential, or arbitrary metadata. An uncertain outcome
uses the `uncertain-termination` category when cancellation or process cleanup
cannot confirm the final state. It must not claim success.

Cancellation is a structural runner command. If cancellation completes before
terminal work, the runtime emits `cancelled`. If termination remains
unconfirmed, it emits the terminal `uncertain` outcome and quarantines the
affected process, session, and workspace lease from reuse. Internal cleanup can
continue until termination is confirmed or the runner is forcibly stopped,
but it cannot emit a later protocol update. A cancellation request does not
create a second terminal outcome.

The runtime rejects malformed decoded input before dispatch. It converts
malformed active-run messages to one failed protocol outcome when it can still
encode that outcome. If encoding fails, it stops protocol output and records
only a bounded local diagnostic. The parent reports uncertain termination when
it cannot decode a terminal outcome; it must not treat a zero process exit as
success.

Version `v1` rejects unknown major versions and unknown fields. A later minor
version can add explicitly optional fields without changing existing meaning.
Consumers must advertise or select a supported version and must not silently
downgrade an unsupported payload. Compatibility tests must cover every
supported version before a version change is released.

The migration also defines one strict `PlanSnapshot` schema for static Plan
data that crosses IPC, Studio, recording, or replay boundaries. The schema has
only the Work and workflow identities plus static node topology. A node can
contain its Plan-node identity, node kind, optional task identity, dependency
identities, parent identity, sibling order, and repeat limit.

The snapshot must not contain task inputs, task outputs, serialized bindings,
schemas, callbacks, credentials, prompts, tokens, secrets, executor data, or
arbitrary metadata. Consumers must receive this snapshot, not a raw Plan. The
schema rejects unknown fields. IPC, Studio, recording, and replay tests must
prove these exclusions.

The current event categories map as follows:

| `@seqlane/events` category | Replacement destination | Compatibility rule |
| --- | --- | --- |
| `run.started`, `invocation.started`, `invocation.progress`, `invocation.succeeded`, `invocation.failed`, `invocation.cancelled`, `run.heartbeat` | Runner notification | Preserve IDs, bounded fields, and run-local sequence semantics. |
| `run.succeeded`, `run.failed`, `run.cancelled` | Serialized run outcome | Emit exactly one terminal outcome. |
| `invocation.created`, `invocation.input`, `invocation.result`, `invocation.output`, `invocation.activity`, `invocation.retrying`, `invocation.skipped` | Mastra observability or bounded runner notification where a consumer needs lifecycle state | Do not expose raw values. |
| `run.plan` and Plan-node topology | Strict `PlanSnapshot` compatibility projection for Studio, recording, and replay | Preserve static identity and topology. Exclude values and executable data. |
| Error metadata and consumer diagnostics | Serialized error category/code or bounded local diagnostic | Omit causes, stacks, credentials, prompts, and unrestricted payloads. |

`@seqlane/events` remains in the repository until runner, CLI, output,
Studio, recording, and replay compatibility tests pass against the replacement
contract. The migration must not create a generic event bus or duplicate
canonical schemas.

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
  input: z.object({ file: z.string() }),
  output: z.object({ code: z.number() }),
  executable: "format",
  argv: ({ input }) => ["--file", input.file],
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
    file: tasks.inspect.output.text,
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

### Shell task boundary

`defineShellTask` accepts an executable and a function that returns an ordered
argv array. The runtime passes both values directly to the process API with
`shell: false`. It never joins argv values into a command string or parses a
workflow value as shell syntax.

The runtime owns the canonical workspace as `cwd` and owns the environment
policy. Public task input cannot override `cwd` or environment values. The
runtime also owns a finite timeout and bounded stdout and stderr limits. On
timeout or cancellation, it terminates the process group and confirms
termination before it releases the workspace lease. Spawn, timeout, output,
cancellation, and termination failures use typed errors with a preserved
cause. A non-zero exit stays in the validated shell task result. The task or
its output schema decides whether that result is acceptable.

The shell contract requires tests for hostile values in each argv element,
argument-boundary preservation, shell metacharacters, output limits,
cancellation, timeout, process-group cleanup, and workspace lease release.

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

The completed cutover ran the dependency-aware concurrency fixtures through
the compiler. Independent eligible nodes can start concurrently when admission
allows it. The runtime removed the Effect runner and its packages. The
compiler has no Effect compatibility path.

### Workflow composition

A workflow is a runnable with input and output schemas. A parent Plan records a
workflow invocation node and the child workflow key. The runtime compiles the
child workflow through the same private compiler boundary and carries parent
identity into the child invocation.

### Bounded repeats

The Plan contains a conceptual `BoundedRepeatNode` with a body and a
`maximumIterations` field. `maximumIterations` is a finite integer from 1
through 1,000. The runtime increments a run-wide repeat-body counter before
each body execution. It rejects or stops before execution 1,001.

Per-node exhaustion returns the existing typed `LoopLimitExceededError`. Run-
wide exhaustion returns a Seqlane-owned typed run-limit error. Nested workflows
and nested repeats add to the same run-wide counter. The implementation must
test malformed limits, per-node exhaustion, run-wide exhaustion, nested
accumulation, and exact-boundary execution at 1,000.

### Observability and runner notification migration

Mastra spans and events carry the canonical bounded telemetry projection. The
projection allowlists safe identifiers, enums, counts, booleans, and
durations. It omits prompts, task inputs and outputs, credentials, tokens,
secrets, headers, filesystem paths, arbitrary metadata, stack traces, and raw
causes. Strings and attribute counts have finite bounds.
The canonical limits are 64 attributes per record, 256 UTF-8 bytes per string
value, and 1,024 UTF-8 bytes for a sanitized local diagnostic. Counts must be
non-negative safe integers. Durations must be finite, non-negative numbers.

The implementation must record time spent waiting for admission after
dependencies become ready. Runner notifications remain narrow and
serializable. Consumers use typed run outcomes for IPC and UI decisions.
Exporter failure must not alter the execution outcome and must produce only a
bounded local diagnostic. Existing `@seqlane/events` consumers move before the
package is deleted. The migration replaces raw Plan transport with the strict
topology-only `PlanSnapshot` projection. IPC, Studio, recording, and replay
tests must reject unknown fields and prove that excluded data cannot cross
their boundaries.

## Failure and edge cases

- Reject a task definition that lacks required schemas or `execute`.
- Reject a specialized factory call that supplies `execute`.
- Reject malformed Plan nodes, bindings, registry entries, and inputs.
- Reject unsupported node kinds before Mastra execution.
- Report policy denial before task execution starts.
- Release every acquired resource after success, error, cancellation, or
  confirmed subprocess termination. Quarantine resources while termination is
  uncertain.
- Preserve the original cause in typed domain errors.
- Bound subprocess output and terminate the process group during cancellation.
- Do not emit a start event before admission succeeds.
- Emit a terminal uncertain outcome and quarantine process, session, and
  workspace resources when termination cannot be confirmed. Do not emit a
  later protocol update.
- Reject unknown runner protocol versions, fields, and malformed envelopes.
- Reject an unknown `PlanSnapshot` field or a snapshot that contains excluded
  Plan values or executable data.
- Emit one terminal serialized run outcome and no later notification.
- Classify unconfirmed cancellation or termination as uncertain termination.
- Stop before repeat execution 1,001 and return the typed run-limit error.
- Keep telemetry export failure out of the execution outcome.
- Prove that IPC, Studio, recording, and replay receive only the typed
  topology-only `PlanSnapshot`.

## Migration

The delivery records use this order:

1. Unify the executable task contract.
2. Unify flow authoring and the minimal Plan.
3. Replace the former Effect subprocess execution. Completed in PR #17.
4. Add the private Mastra Plan compiler.
5. Cut over the runtime to Mastra and remove Effect. Completed in PR #26.
6. Compose workflows as runnables.
7. Add Mastra observability. Native agent projections completed in PR #75.
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
- Effect packages, code, and compatibility paths are absent.
- Admission remains Seqlane-owned and atomic after Mastra eligibility.
- Existing dependency-aware concurrency remains compatible. Independent work
  can complete and notify in non-deterministic order.
- Cancellation, bounded output, cleanup, and typed errors remain covered.
- Mastra observability includes Seqlane semantic attributes and admission wait.
- Runner and UI consumers retain narrow notifications and typed outcomes.
- `@seqlane/events` is removed only after its consumers migrate.
- Runner schemas, envelope ordering, terminal outcome, cancellation,
  malformed-input, and compatibility tests pass.
- Shell tasks use direct executable-plus-argv spawning with `shell: false`.
- Telemetry uses the bounded allowlist and exporter-failure behavior.
- Repeat limits accept 1..1,000 and enforce the 1,000 run-wide budget.
- CLI, output, Studio, recording, and replay behavior remains available.
- Each completed task records its verification and traceability. Planned tasks
  retain their own completion criteria.

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
