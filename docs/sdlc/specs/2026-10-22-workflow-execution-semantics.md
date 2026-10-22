---
id: spec.workflow-execution-semantics
title: Workflow Authoring and Execution Semantics
status: active
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - rfc.effect-v4-migration
  - prd.seqlane-runtime
  - adr.exclusive-flow-choice
supersedes:
  - spec.fluent-seqlane-flow-dsl
---

# Workflow Authoring and Execution Semantics

## Summary

This document owns retained task, workflow, Plan, choice, repeat, binding, and
runner semantics. Effect execution mechanisms belong to
[the runtime contract](./2026-10-21-effect-v4-execution-and-operations.md).
This transfer establishes current authority; it does not rewrite delivery history.

## Goals

Keep one executable task contract and one fluent workflow API. Preserve typed
values, invocation identity, policy admission, observable outcomes, and executor
independence through the shared private Effect program.

## Non-goals

No general foreach, arbitrary runtime predicate, action replay, durable resume,
public engine type, public task plugin surface, or second scheduler is added.

## Requirements

### REQ-TASK-001: Use one executable task contract

`defineTask` must require `id`, `input`, `output`, and `execute`. The input and
output fields must be Zod schemas. The public type must infer input and output
types from those schemas.

`defineAgentTask` and `defineShellTask` are convenience factories that return
that same task contract. Each factory provides its own `execute`
implementation. A caller must not pass `execute` to a specialized factory.

Specialized factories must be executor-neutral convenience constructors. They
must not expose runtime-engine, OpenCode, provider, client, connection, or other
executor product types.

`defineAgentTask` accepts an optional positive integer `timeoutMs`. It defaults
to 120,000 milliseconds and bounds one agent invocation from adapter-reported
external execution start to a terminal adapter outcome. A task can override
that default. Workflow and adapter admission or queue time do not consume the
budget. The runtime owns the deadline signal; adapter configuration cannot
override it. `defineShellTask` retains its existing independent `timeoutMs`
option.

The foundational execution shape is:

```ts
type TaskExecute<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
> = (request: {
  readonly input: z.output<InputSchema>;
  readonly signal: AbortSignal;
  readonly context: TaskContext;
}) => Promise<z.input<OutputSchema>>;
```

The runtime parses input before `execute`. It parses the returned value with
the output schema. The successful task result has type
`z.output<OutputSchema>`.

`TaskContext` is runtime-owned and executor-neutral. It provides a direct
executable-plus-argv process operation and an agent operation without exposing
runtime-engine, OpenCode, provider, client, or connection types. A task can call either
operation. The context is bound to the invocation's admitted workspace and,
when declared, its session policy.

The factories do not create separate task types or execution discriminators.
They close over their authoring input and produce ordinary `TaskDefinition`
values. A caller can use `defineTask` directly to combine deterministic code
with the same runtime context operations.

### REQ-TASK-002: Use one workflow authoring API

The public workflow API must use `createFlow(...).task(...).output(...).define()`.
The API must not support `defineWorkflow({ build })`.

The API must infer dependencies from references and explicit invocation data.
Declaration order alone must not create a dependency.

### REQ-TASK-003: Treat workflows as runnables

Every location that accepts a task or runnable must accept a workflow. A
workflow invocation must have a typed input and output contract. Nested
workflow invocations must retain node identity and input binding information.

### REQ-CHOICE-001: Route one runnable

A named Flow choice uses `.when(...).task(...).otherwise(...)`. `when` accepts
the condition callback and returns a builder that requires `.task()` next.
That `.task()` supplies the true runnable, binding, name, and optional policy;
it does not create a separate ordinary task node. It returns a builder that
requires `.otherwise()` before another declaration or Flow output.
`.otherwise()` supplies the false runnable, binding, and optional policy.
Each arm contains one task or child workflow with its own typed input binding
and ordinary invocation policy.
All Plan declarations share one node ID allocator. A task or workflow named
`choice` remains valid and receives a distinct ID from a generated choice,
regardless of declaration order. Bindings refer to the allocated IDs.

The condition callback returns one `ValueRef<boolean>` from workflow input or
an earlier task result. It cannot reference the pending choice or a later
declaration. The callback runs only during Plan construction; it is not a
runtime predicate. Authors who need a computed condition use a normal
deterministic task to produce the Boolean result.

The choice must execute exactly one arm: `then` for `true`, `else` for `false`.
The other arm starts no work and is reported as not selected. It must not
consume session or workspace admission or cause a successful run to fail.
Failure or cancellation of the selected arm must not start the other arm as a
fallback. The selected arm keeps its own task or workflow identity, nested
invocation behavior, and existing session and workspace policies.
Selected-arm preflight failures emit failure directly. They must not emit
`invocation.started` before session and workspace admission succeeds.
The choice waits for its condition, arm input references, and declared
dependencies before selection. A session source used only by an arm remains
an arm dependency. The selected arm waits for that source to complete before
it materializes the session. The other arm's session source does not delay
selection. Cancellation during this wait cancels the selected arm and choice
without emitting a task start or failure event. It preserves the cancelled run
outcome. If an upstream failure or cancellation prevents the choice from
starting, both created arm invocations receive terminal events.

Both runnables must declare output schemas. The named choice output has the
union of their inferred output types. Each runnable parses its output once
through its own schema. The choice forwards the selected validated value
through its `.task()` name. A downstream binding must accept or narrow the
union. The workflow output schema validates the final resolved value.
Downstream bindings refer to this handle, not to either arm. The choice is
control flow, not a new task definition or model invocation.

Task arms can declare their ordinary output validator. Only the selected
arm's validator runs. It must accept the output before the arm stores a result
or emits success or result events. Rejection fails both the arm and choice.
An evaluator task acquires workspace admission after the arm releases its
execution workspace admission. The arm retains session admission until its
checkpoint is captured. A model requirement on an unselected arm does not block
the run; the selected arm's model is checked when that arm becomes eligible.

### REQ-PLAN-001: Keep a small Seqlane Plan boundary

The Plan must be serializable and independent of runtime engines. It must not contain
Effect values or types. Authors
must receive a workflow or runnable; they must not hand-build a Plan.

The Plan must contain only task invocation, workflow invocation, validation
check, validation gate, bounded repeat, and exclusive choice nodes. A registry
must resolve runnable references without placing executable functions in
serialized data.

### REQ-PLAN-002: Validate Plan data at runtime

Zod schemas must define Plan nodes, bindings, and serialized run data. The
runtime must validate registry keys and each referenced definition with its
owning schema. Malformed data must produce typed errors. The runtime must not
use unchecked JSON parsing or handwritten type predicates.

### REQ-POLICY-001: Apply policy after eligibility

The Effect Plan program identifies nodes whose dependencies are ready. Seqlane must
apply session and workspace policy before execution starts. Admission must stay
atomic across all resources that the invocation needs.

Admission wait after dependencies become ready must be observable. Session
reuse, forking, ordering, and workspace identity must follow the active
policy and session specifications.

All runnable invocations can declare workspace policy. A task invocation can
declare session policy. The runtime resolves that policy before execution and
binds `TaskContext.runAgent()` to the resulting session. A task that does not
call `runAgent()` does not use the session. A nested workflow retains its
internal policies and does not receive a synthetic session.

### REQ-RUNTIME-001: Compile behind a private boundary

The compiler must accept a validated Seqlane Plan and produce a private Effect
program. Effect types remain inside the private runtime integration boundary.

The compiler must reuse the invocation kernel. It must preserve typed outcomes,
cancellation, process cleanup, policy failures, and deterministic node identity.

Runnable input preparation has one owning schema parse per invocation. The
compiler passes prepared input to the invocation kernel without resolving or
parsing it again. Direct kernel calls prepare raw input through the same helper.
Ordinary task and selected-choice input failures remain before kernel admission.
Repeat attempts and validation checks retain their existing failure timing.
Schema transforms must reach the runnable unchanged, including `null` and
`undefined` results. Private integration envelopes, when needed, have a separate validation boundary.

Builder option types derive from the canonical invocation contracts. Ordinary,
repeat and choice declarations share runnable option resolution and Plan-node
construction. Their topology remains distinct. Choice eligibility must exclude
session-source dependencies that only the selected arm waits for.

Dependencies establish eligibility. Independent eligible nodes can execute
concurrently. Seqlane session and workspace admission determine actual starts.
Completion and notification order for independent work is not deterministic.
The Plan interpreter must not add a second scheduling policy.

### REQ-RUNNER-001: Own serialized contracts in protocol

`@seqlane/protocol` owns canonical Zod schemas and inferred types for runner
commands, execution events, serialized errors, Plan snapshots, and codecs.
Core owns authoring and Plan meaning. No engine or executor type crosses IPC.
Runtime and consumers use the canonical contracts without a duplicate event bus.

Keep the existing protocol version and meaning unless an explicit field change
requires a version update. Reject unsupported versions, unknown fields, and
malformed envelopes before dispatch. Test each supported version. Consumers
must not silently downgrade a payload.

Each run has stable Work and Run identities and one run-local sequence.
Sequences start at one and increase by one for accepted events. Emit exactly
one terminal outcome after earlier accepted events settle; emit no later update.
A zero runner exit without a decodable terminal outcome never proves success.
Malformed active-run input produces one protocol failure when it can be encoded;
otherwise stop transport and report the bounded supervisor failure.

Cancellation is structural and idempotent. Confirmed cancellation preserves its
category. Unconfirmed external termination produces an uncertain outcome and
quarantines affected resources; internal cleanup cannot publish a second outcome.
Errors use stable category and code with a bounded sanitized message. Categories
include protocol, validation, policy, task, subprocess, cancellation,
uncertain-termination, and internal. Original causes remain private.

The topology-only `PlanSnapshot` contains Work/workflow identity, node identity
and kind, optional task identity, dependency and parent identities, sibling
order, repeat limit, and explicit choice-arm relationships. It contains no task
values, serialized bindings, schemas, callbacks, prompts, credentials, tokens,
executor state, or arbitrary metadata. Consumers receive the snapshot, never a
raw Plan. Strict schemas reject unknown fields.

The snapshot's exclusions do not suppress canonical invocation values.
`invocation.created`, `invocation.input`, `invocation.result`,
`invocation.activity`, `invocation.observation`, `invocation.retrying`, and
`invocation.skipped` retain their protocol meaning. Input, result, activity,
and observation events preserve complete valid JSON values. The TUI may evict
whole records with visible notices; retained values stay complete.
Output-channel capture and terminal rendering retain their existing finite bounds.

### REQ-COMPAT-001: Preserve user-visible contracts

Preserve current CLI output, cancellation, final-result error classification,
Plan inspection, supplied-file replay, and hosted inspection. Oclif owns command
conventions and Zod owns public and wire validation. The runtime specification
records intentional launcher removal and hosted-history discontinuity.
Standalone execution adds no recorder or durable history.

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

const shellTaskResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

const shellTask = defineShellTask({
  id: "format-change",
  input: z.object({ file: z.string() }),
  executable: "format",
  argv: ({ input }) => ["--file", input.file],
});

const review = createFlow({
  id: "review",
  input: z.object({ prompt: z.string() }),
  output: shellTaskResultSchema,
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
  output: shellTaskResultSchema,
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
- A bounded repeat is authored by chaining `.until(...)` immediately after
  `.task(...)`. The task can invoke a task definition or child workflow.
  Ordinary `.task(...)` still invokes its runnable once.
- An exclusive choice is authored by chaining
  `.when(...).task(...).otherwise(...)`. `when` starts the choice. The following
  task is its true arm, and `otherwise` supplies the false arm. The task name
  is the result handle; both runnables retain their own IDs.

The choice authoring shape is:

```ts
const decisionSchema = z.discriminatedUnion("kind", [
  securityDecisionSchema,
  standardDecisionSchema,
]);

createFlow({ id, input: workflowInputSchema, output: decisionSchema })
  .task("triage", triageTask, ({ input }) => ({ change: input.change }))
  .when(({ tasks }) => tasks.triage.output.needsSecurityReview)
  .task("decision", securityReviewTask, ({ input }) => ({
    change: input.change,
  }))
  .otherwise(standardApprovalTask, ({ input }) => ({
    change: input.change,
  }))
  .output(({ tasks }) => tasks.decision.output)
  .define();
```

`securityReviewTask` and `standardApprovalTask` may declare different output
schemas. Their inferred output types form the type of `tasks.decision.output`.
That type is the union of `z.output<typeof securityDecisionSchema>` and
`z.output<typeof standardDecisionSchema>`.
With no downstream task, `.output(...)` binds that union directly to the
workflow result. `decisionSchema` validates either result. The condition is a
reference to an already validated Boolean.

### Plan node and registry boundary

The Plan contains serializable descriptors and bindings. A registry maps stable
task and workflow keys to executable definitions at runtime. The registry is
not serialized. The private Plan interpreter resolves this registry when preparing invocations.

The node union has these conceptual forms:

```ts
type PlanNode =
  | TaskInvocationNode
  | WorkflowInvocationNode
  | ValidationCheckNode
  | ValidationGateNode
  | BoundedRepeatNode
  | ChoiceNode;
```

The implementation must keep node addresses separate from invocation
identities. The Plan records dependencies and bindings. Runtime state records
attempt, session, workspace, admission, outcome, and error data.

### Exclusive choice

`ChoiceNode` records a stable node ID, one Boolean reference, `then` and
`else` task-or-workflow invocation descriptors, and outer dependencies. It
stores no executable callback, Zod schema, runtime-engine object, or decision result.
Its serializable shape is:

```ts
interface ChoiceNode {
  readonly type: "choice";
  readonly nodeId: PlanNodeId;
  readonly condition: ValueRefData;
  readonly then: TaskNode | WorkflowNode;
  readonly else: TaskNode | WorkflowNode;
  readonly dependsOn: readonly PlanNodeId[];
}
```

Its chosen output is addressable through the choice node ID. Arm node IDs are
distinct and stable for execution and inspection. The in-memory registry
resolves both runnable definitions and their output schemas.

The builder collects choice dependencies from the condition, both arm input
bindings, and declared dependencies. Session sources remain on their arms.
It rejects self, later, missing, or non-Boolean references. Static
prerequisites must finish before selection;
authors put work needed only by one arm inside that arm's child workflow.
Plan validation rejects malformed arm nodes, duplicate IDs, cycles, and missing
definitions. The authoring handle carries the union of both inferred output
types. The runtime validates the resolved condition as a Boolean before
selection.

The Effect Plan interpreter resolves the Boolean condition and invokes only the
selected arm through the ordinary invocation kernel and atomic admission.
The other arm acquires no resource and emits no start event. Selected failure
or cancellation never falls back to the other arm. The choice forwards the
selected runnable's already parsed output for downstream binding resolution.
The result reference uses the ordinary `["output"]` path; choice does not parse
that value a second time.

Plan snapshots contain the choice and both arm nodes. The arms have the choice
as parent. Typed `thenPlanNodeId` and `elsePlanNodeId` links and each arm's
`choiceArm` role preserve the two routes through serialization and replay.
Arm dependencies and session sources remain visible in the snapshot. Runtime
topology creates both arm invocations with their original task or workflow
identities; a child workflow uses a workflow subject in created and started
events. Selection emits `invocation.skipped` for the other arm with a reason
that identifies it as unselected. If the choice never starts after upstream
failure or cancellation, both arms terminate as skipped or cancelled. The
choice completes after the selected arm, and its output remains available to
downstream bindings. Its result event preserves the full selected JSON value,
consistent with ordinary task result events.

### Shell task boundary

`defineShellTask` accepts an executable and a function that returns an ordered
argv array. It owns the canonical `shellTaskResultSchema` output contract:
`{ exitCode, stdout, stderr }`. A process that starts, terminates, and produces
that result is a successful task execution regardless of its exit code. A
later task or validation gate can apply workflow-specific exit-code policy.
The runtime passes the executable and argv directly to the process API with
`shell: false`. It never joins argv values into a command string or parses a
workflow value as shell syntax.

The runtime owns the canonical workspace as `cwd` and owns the environment
policy. Public task input cannot override `cwd` or environment values. The
runtime also owns a finite timeout and bounded stdout and stderr limits. On
timeout or cancellation, it terminates the process group and confirms
termination before it releases the workspace lease. Spawn, timeout, output,
cancellation, and termination failures use typed errors with a preserved
cause. A non-zero exit stays in the validated shell task result. A later task
or validation gate decides whether that result is acceptable.

The shell contract requires tests for hostile values in each argv element,
argument-boundary preservation, shell metacharacters, output limits,
cancellation, timeout, process-group cleanup, and workspace lease release.

### Policy ordering

1. Validate the workflow, registry, Plan, input, and active policy.
2. Prepare the private Effect program and determine dependency eligibility.
3. Report eligibility and wait when session or workspace admission blocks start.
4. Acquire session and workspace resources atomically.
5. Invoke the task through the shared invocation kernel.
6. Confirm external termination, release owned resources, and publish the outcome.

No start event precedes successful admission. Typed failures preserve causes.
Unconfirmed external termination quarantines affected ownership.

### Workflow composition

A workflow is a runnable with input and output schemas. A parent Plan records a
workflow invocation node and the child workflow key. The runtime executes the
child workflow through the same private Effect program boundary and carries parent
identity into the child invocation.

### Bounded repeats

The Plan contains a conceptual `BoundedRepeatNode` with one task or child
workflow attempt, an initial input binding, a boolean result reference, an
optional next-input binding, and a `maximumIterations` field. Authors use
`.task(...).until(...)`; the former `.repeat(...)` body builder is superseded
by [the fluent task-until contract](./2026-09-14-fluent-task-until-repeats.md).
The attempt runs before Seqlane checks the condition. `maximumIterations` is a
finite integer from 1 through 1,000. The runtime increments a run-wide
attempt counter before each execution and rejects execution 1,001.

Per-node exhaustion returns the existing typed `LoopLimitExceededError`. Run-
wide exhaustion returns a Seqlane-owned typed run-limit error. Nested workflows
and nested repeats add to the same run-wide counter. The implementation must
test malformed limits, per-node exhaustion, run-wide exhaustion, nested
accumulation, and exact-boundary execution at 1,000.

The Effect program evaluates the condition after each completed attempt. Every
attempt retains normal invocation identity, input and output validation,
admission, cancellation, and observability. A repeated child workflow keeps
the same admission and internal policies as an ordinary child invocation.

## Verification

Run test mapping before mapped tests. Cover valid and invalid fluent chains,
Zod input/output transformations, false-like values, malformed Plans and
registries, dependency concurrency, choice selection, unselected arms,
validation, nested identity, exact repeat limits, and cancellation.
Use real Effect compositions for CLI and direct runtime paths. Test protocol
compatibility, unknown fields, sequencing, snapshot exclusions, complete event
values, single terminal settlement, and public declarations without engine types.

## Acceptance criteria

One public task contract and fluent API cover tasks and child workflows.
Dependencies determine eligibility; session and workspace policy determine starts.
Choices execute one arm and repeats preserve each attempt's identity and budget.
Public and wire boundaries remain engine-independent and Zod-owned.

## Delivery state

Requirements transferred during final removal. Historical task outcomes remain
historical claims. The S12 release gate owns final verification and exact-head CI.

## Traceability

- Supersedes [the earlier Flow DSL proposal](./2026-09-02-fluent-seqlane-flow-dsl.md).

- [rfc.effect-v4-migration: Runtime architecture](../rfcs/2026-10-21-effect-v4-migration.md)
- [prd.seqlane-runtime: Product requirements](../prd/2026-10-21-seqlane-runtime.md)
- [adr.exclusive-flow-choice: Exclusive choice decision](../adrs/2026-09-26-exclusive-flow-choice.md)
- [Effect execution and operations](./2026-10-21-effect-v4-execution-and-operations.md)
- [Session semantics](./2026-09-02-session-checkpoint-reuse-and-branching.md)
- [Workspace admission](./2026-09-02-invocation-admission-and-workspace-coordination.md)
- [Mechanical tasks](./2026-09-03-local-mechanical-tasks.md)
- [Fluent repeats](./2026-09-14-fluent-task-until-repeats.md)
- [Runner process](./2026-09-02-dedicated-runner-process.md)
- [Canonical observations](./2026-09-19-otel-aligned-observation-contract.md)
- [Final removal and release](../tasks/2026-10-21-effect-v4-complete-removal-and-release.md)
