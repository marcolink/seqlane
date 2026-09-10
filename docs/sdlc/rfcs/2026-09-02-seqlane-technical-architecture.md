---
id: rfc.seqlane-technical-architecture
title: Seqlane Technical Architecture
status: superseded
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - prd.seqlane
supersedes: []
---

# Seqlane Technical Architecture

> Superseded by [rfc.mastra-runtime-and-operational-foundation](./2026-09-03-mastra-runtime-and-operational-foundation.md).

## 1. Purpose

This RFC defines the technical architecture for Seqlane. The PRD defines what users must be able to do; this RFC defines the system model and technical contracts required to support those requirements.

## 2. Architecture

```text
TypeScript authoring API
        │
        ▼
Seqlane Plan IR
        │
        ▼
Seqlane Runtime
        │
        ├── private workflow engine: Mastra
        │
        ▼
Executor
        │
        ▼
External execution environment
```

For CLI execution:

```text
oclif CLI
   │
   │ Seqlane protocol
   ▼
dedicated runner process
   │
   ├── workflow loading
   ├── Plan construction
   ├── Mastra runtime
   └── Executors
```

## 3. Architectural Boundaries

Seqlane owns:

- Task;
- Workflow;
- Plan;
- `ValueRef`;
- Expression;
- Executor;
- Work;
- Run;
- Invocation;
- resource/effect policy;
- runtime events;
- results/errors.

Mastra and OpenCode remain implementation dependencies behind Seqlane-owned contracts. Neither may leak into the public workflow API.

## 4. Package Boundaries

Initial package structure:

```text
@seqlane/core
@seqlane/runtime
@seqlane/opencode
seqlane
```

### `@seqlane/core`

Contains task/workflow contracts, schema abstraction, `ValueRef<T>`, input bindings, expression IR, Plan IR, executor interfaces, execution identities, and Seqlane errors/results/events. It must have no Mastra dependency.

### `@seqlane/runtime`

Contains workflow loading, Plan construction and validation, dependency analysis, Mastra compiler, run lifecycle, runner entry point, executor routing, cancellation, and later resource admission. Mastra is a private dependency here.

### `@seqlane/opencode`

Contains OpenCode executor, client/runtime integration, session management, structured output integration, Harness Overlay implementation, cancellation, and OpenCode event translation. It depends on Seqlane contracts rather than Mastra contracts.

### `seqlane`

Contains oclif commands, workflow discovery, runner launching, event rendering, signal forwarding, and exit-code handling. It must not own workflow execution state.

## 5. Task Model

A Task is a reusable typed execution unit.

```ts
interface TaskDefinition<
  Id extends string,
  Input,
  Output,
> {
  id: Id
  input: Schema<Input>
  output: Schema<Output>
}
```

Invocation-specific policy does not belong in the task identity, including session, model, retry attempt, resource acquisition, Invocation ID, or workspace instance.

Executor-specific task factories may extend the authoring API.

## 6. Workflow Model

A Workflow builds a serializable Seqlane Plan.

```ts
seqlane.workflow({
  id: "example",
  input: InputSchema,

  build({ input, run }) {
    const a = run(taskA, {
      input: { value: input.value },
    })

    const b = run(taskB, {
      input: { value: a.output.result },
    })

    return b.output
  },
})
```

`build()` executes during Plan construction. It does not execute tasks.

Callbacks used for authoring structured control flow similarly construct Plan nodes and must not become arbitrary runtime JavaScript callbacks.

## 7. Typed Dataflow

Dataflow is the primary orchestration mechanism.

```ts
const b = run(taskB, {
  input: {
    value: a.output.value,
  },
})
```

implies:

```text
A → B
```

No separate sequencing declaration is required.

If two nodes depend on A but not each other:

```text
   A
  ↙ ↘
 B   C
```

the Plan records them as independent even if a particular runtime profile executes them serially.

## 8. `ValueRef<T>`

Task outputs produce typed references.

Given:

```ts
output: z.object({
  files: z.array(z.string()),
  confidence: z.number(),
})
```

Seqlane must infer:

```ts
result.output
// ValueRef<{ files: string[]; confidence: number }>

result.output.files
// ValueRef<string[]>

result.output.confidence
// ValueRef<number>
```

Nested property access must preserve types. Internally a reference may serialize as:

```json
{
  "invocation": "inv_123",
  "path": ["output", "details", "severity"]
}
```

The public API must not require string-based paths.

## 9. Input Bindings

Task input recursively accepts compatible literals, Seqlane references, and nested combinations of both.

Conceptually:

```ts
InputBinding<T>
```

Invalid connections must fail at TypeScript compile time.

## 10. Type-System Requirements

Type-system behavior is part of Seqlane correctness.

Normal authoring must not require `any`, recovery from `unknown`, casts, manual generic parameters, or string-based refs for information Seqlane already knows.

Dedicated compile-time tests must cover at least nested `ValueRef<T>`, `InputBinding<T>`, workflow output inference, nested workflow invocation, expression typing, branch typing when introduced, and executor option inference.

## 11. Runtime Validation

Every external result crosses:

```text
executor output
      ↓
runtime schema validation
      ↓
typed Seqlane output
```

The meaning of `ValueRef<T>` is that Seqlane has validated the runtime value as `T`. Executor-side validation may supplement but never replace Seqlane validation.

## 12. Plan IR

Seqlane owns a serializable Plan representation independent of Mastra.

```ts
interface Plan {
  workflow: WorkflowIdentity
  nodes: PlanNode[]
  output: ValueBinding
}

type PlanNode =
  | TaskNode
  | BranchNode
  | RepeatNode
  | ParallelPolicyNode
```

Ordinary sequencing is represented through dependency edges rather than explicit sequence nodes. The MVP needs only the static DAG subset.

## 13. Structured Control Flow

Where dataflow alone is insufficient, Seqlane may introduce typed `branch`, `repeat`, and `foreach` primitives.

These must produce serializable Plan IR, preserve static types, make execution paths observable, and avoid embedding arbitrary runtime callbacks.

They are part of the full architecture but not the MVP.

## 14. Internal Workflow Engine

Mastra is Seqlane's foundational internal workflow engine.

```text
Seqlane workflow
      ↓
Seqlane Plan
      ↓
Seqlane validation
      ↓
Seqlane → Mastra compiler
      ↓
Mastra execution
      ↓
Seqlane executor wrapper
      ↓
Executor
```

Seqlane consumers must not encounter Mastra workflow objects, result types, errors, configuration, or terminology.

## 15. Executor Abstraction

Seqlane uses a generic Executor boundary.

```ts
interface Executor {
  execute<I, O>(
    request: ExecutionRequest<I, O>,
  ): Promise<ExecutionResult<O>>
}
```

An execution request contains Seqlane-owned concepts such as Invocation identity, validated input, cancellation signal, and executor-specific typed options.

Potential executors include OpenCode, Local, HTTP, MCP, and Remote. Only OpenCode is required by the MVP.

## 16. OpenCode Integration

OpenCode is the initial repository-aware coding executor.

The OpenCode adapter uses the typed OpenCode SDK/server API internally. Raw OpenCode types and identifiers must not enter the Seqlane Plan or workflow authoring API.

## 17. OpenCode Repository Harness

OpenCode remains authoritative for repository-specific agent configuration.

Seqlane does not reinterpret or reconstruct:

- `AGENTS.md`;
- OpenCode configuration;
- skills;
- agents;
- tools;
- plugins;
- MCP;
- repository instructions.

The semantic model is:

```text
Repository OpenCode Harness
            +
Seqlane Harness Overlay
            +
Invocation Objective
            ↓
         OpenCode
```

## 18. Harness Overlay

Seqlane may augment the existing OpenCode harness.

```ts
interface OpenCodeHarnessOverlay {
  instructions?: InstructionSource[]
  references?: ReferenceSource[]
  skills?: SkillDefinition[]
  tools?: ToolDefinition[]
  mcp?: McpDefinition[]
}
```

The overlay is additive by default. Seqlane must not silently replace repository capabilities.

### 18.1 Instructions vs References

Instructions are normative. References are knowledge available to the agent. They must remain distinct concepts.

Seqlane should avoid concatenating all reference material into prompts when progressive/native disclosure mechanisms are available.

### 18.2 Native Capabilities Remain Native

A Seqlane-provided skill, tool, or MCP integration should remain that capability inside OpenCode rather than being converted into prompt text.

### 18.3 Capability Collisions

Seqlane extensions must not silently shadow repository or OpenCode capabilities. Collision behavior must be deterministic. Seqlane-generated capabilities should be namespaced where practical.

## 19. OpenCode Runtime Modes

The full architecture supports:

- **Managed Runtime** — Seqlane starts, owns, and stops the OpenCode runtime.
- **External Runtime** — Seqlane connects to an existing OpenCode server but does not own its lifecycle.
- **Existing Session** — Seqlane attaches to an explicitly selected existing OpenCode session; the session remains externally owned.

The MVP implements External Runtime only. Existing Session remains post-MVP.

## 20. OpenCode Session Model

The full architecture supports shared, isolated, and forked sessions.

```ts
const main = opencode.session("main")

session: main
session: opencode.isolated()
session: main.forkFrom(implementation)
```

Session identity is separate from model identity.

### 20.1 Shared-Session Serialization

Invocations using the same OpenCode session are serialized by Seqlane.

### 20.2 Checkpoints

Every successful OpenCode invocation should eventually retain its exact checkpoint: session ID plus final assistant message ID. This supports deterministic forks and observability. Raw OpenCode identifiers remain runtime metadata. Checkpoint/fork support is post-MVP.

## 21. Structured OpenCode Output

Typed OpenCode tasks use structured output whenever they declare an output schema.

```text
Seqlane schema
      ↓
OpenCode structured generation
      ↓
OpenCode result
      ↓
Seqlane validation
      ↓
Seqlane output
```

Conversation history, tool calls, shell commands, and subagent activity are execution context/observability, not Seqlane semantic dataflow.

## 22. Autonomous Runtime

A Seqlane Run is non-interactive.

Once execution begins, the runner must progress until success, failure, or cancellation without user decisions.

The runtime must not request user input, confirmation, permission decisions, or option selection. Any unresolved interaction requirement fails the invocation/run.

## 23. Permission Handling

Seqlane must never silently increase OpenCode authority. The OpenCode environment must have sufficient preconfigured policy for autonomous execution.

If OpenCode requires permission not covered by that policy, the invocation fails. The CLI does not mediate permissions in V1.

## 24. Dedicated Runner Process

Each `seqlane run` executes in a fresh Node process.

```text
oclif parent
    │
    ▼
Seqlane runner
    │
    ├── workflow import
    ├── Plan construction
    ├── Mastra
    ├── executors
    └── run state
```

The runner is foreground, child-owned by the CLI, not detached, not persistent, and never reused across independent runs.

## 25. CLI Responsibilities

The oclif process is limited to command parsing, workflow resolution, runner launching, event rendering, signal forwarding, and exit status.

It must not contain Mastra run state, executor state, workflow orchestration decisions, or agent interaction decisions.

## 26. Runner Protocol

Seqlane owns a serializable CLI ↔ runner contract.

V1 requires:

```ts
type RunnerCommand =
  | RunRequest
  | CancelRun
```

Runner-to-CLI communication uses structured Seqlane lifecycle events. No Mastra or OpenCode event types cross the process boundary directly.

The protocol is transport-independent semantically; Node IPC is the initial transport.

## 27. Cancellation

```text
SIGINT / SIGTERM
       ↓
      CLI
       ↓
   CancelRun
       ↓
runner AbortController
       ↓
 executor abort
       ↓
 OpenCode abort
       ↓
 cleanup + exit
```

Hard process termination is a fallback, not the normal cancellation mechanism. Externally owned OpenCode runtimes are never terminated by Seqlane.

## 28. Execution Identities

Seqlane distinguishes definition identity from execution identity.

Definition identities:

- Workflow ID;
- Task ID.

Execution identities:

```text
Work
  ↓
Run
  ↓
Invocation
```

**Work** represents one logical engineering objective and may span multiple Runs. **Run** represents one concrete Seqlane runtime execution. **Invocation** represents one task/workflow-node execution within a Run.

This hierarchy is canonical even though cross-run continuation is post-MVP.

## 29. Git Provenance

Seqlane should eventually associate repository commits with execution provenance.

Recommended Git trailers:

```text
Seqlane-Work: work_...
Seqlane-Run: run_...
Seqlane-Invocation: inv_...
Seqlane-Task: apply-fix
```

`Seqlane-Task` is descriptive metadata and is not a correlation identifier.

Seqlane should eventually retain commit SHAs associated with invocations/runs. Implementation of Git provenance and cross-run Work continuation is outside the MVP.

## 30. Resource and Effect Model

Seqlane execution policy is independent of agent sessions.

Resources eventually support at least `shared` and `exclusive`. Different OpenCode sessions may still conflict on the same workspace.

Effective scheduling therefore combines data dependencies, control flow, resource admission, and session admission. Resources are post-MVP.

## 31. Retry Safety

Seqlane owns retry safety; the workflow engine may own retry mechanics.

Seqlane must not blindly retry mutating work. Future retry behavior should account for effects such as read, write, and external side effect and require explicit safety for non-idempotent operations.

The MVP performs a single attempt per invocation.

## 32. Security Model

Seqlane repository, user workflow, and harness code are considered trusted internal code.

The main security boundary is executor authority.

The runtime must preserve these invariants:

- Seqlane never implicitly broadens executor authority.
- Execution policy must be resolvable without interactive approval.
- Sensitive execution data must not be persisted or exposed unnecessarily.
- External OpenCode runtime/session compatibility must be validated.
- Schema validation establishes type integrity, not authorization.
- Mutating work must not be automatically retried without explicit safety.
- External content is data, not execution authority.

Untrusted-repository sandboxing is a separate future security profile.

## 33. Capability Discovery and Composition

Product-level repository/user composition requirements are defined by the PRD.

Technically:

- Task and Workflow definitions remain ordinary TypeScript values.
- Composition uses normal TypeScript imports.
- Locally defined tasks require no runtime registration.
- Workflows and tasks use the same typed invocation model.
- Discovery is separate from execution semantics.
- Ambiguous discovered names must remain distinguishable rather than relying on implicit shadowing.

Seqlane should not introduce a proprietary package/module system. Reusable distribution may use normal npm/TypeScript packaging.

## 34. Workflow Testing

Workflow semantics must be testable without a live executor.

The architecture must allow a substitute executor to test Plan construction, bindings, dependency inference, control flow, workflow outputs, and schema behavior.

The exact public testing API remains undecided.

## 35. Observability Boundary

rfc.execution-observability-and-debugging defines observability behavior.

rfc.seqlane-technical-architecture requires the runtime to preserve enough structure to support it. At minimum, runtime events must retain Work ID when available, Run ID, Invocation ID, Task ID, workflow identity, dependency relationships, executor identity, status transitions, validation result, session metadata where relevant, errors, and timestamps.

CLI output is merely a projection of these structured runtime events.

## 36. MVP Technical Profile

### Included

- CLI only;
- oclif;
- dedicated Node runner;
- static typed DAG;
- ValueRef-based dataflow;
- Mastra internally;
- OpenCode-only executor;
- externally running OpenCode server;
- single OpenCode session;
- serial task execution;
- structured OpenCode outputs;
- Seqlane output validation;
- non-interactive autonomous execution;
- basic lifecycle events;
- cancellation;
- repository/user workflow discovery.

### Deferred

- managed OpenCode runtime;
- existing-session attachment;
- Harness Overlay materialization;
- native Seqlane-added skills/tools/MCP;
- multiple sessions;
- isolated/forked sessions;
- model profiles;
- branches;
- repeat/foreach;
- parallel execution;
- resources;
- effects;
- retries;
- LocalExecutor;
- persistent RunRecord;
- Git provenance;
- cross-run Work continuation;
- managed scheduling;
- loop engineering.

## 37. Canonical Technical Example

```ts
export default seqlane.workflow({
  id: "fix-renovate-update",
  input: RenovateUpdateInput,

  build({ input, run }) {
    const investigation = run(investigateRenovateFailure, {
      input,
    })

    const plan = run(planRenovateFix, {
      input: {
        investigation: investigation.output,
      },
    })

    const fix = run(applyRenovateFix, {
      input: {
        plan: plan.output,
      },
    })

    const verification = run(verifyRenovateFix, {
      input: {
        change: fix.output,
      },
    })

    return {
      change: fix.output,
      verification: verification.output,
    }
  },
})
```

The resulting MVP Plan is approximately:

```text
investigate
    ↓
  plan
    ↓
   fix
    ↓
 verify
```

The workflow source contains no Mastra or OpenCode SDK objects.

## 38. Locked Technical Decisions

### Core

- **T1** — Seqlane owns its public task/workflow/runtime model.
- **T2** — Typed dataflow is the primary orchestration mechanism.
- **T3** — Data dependencies imply scheduling relationships.
- **T4** — Seqlane owns a serializable Plan IR.
- **T5** — `ValueRef<T>` behaves like a typed value/property reference.
- **T6** — External outputs require Seqlane runtime validation.
- **T7** — Workflow and task composition use one invocation model.
- **T8** — Plan-building callbacks are allowed; arbitrary runtime callbacks are not.

### Runtime

- **T9** — Mastra is the internal workflow engine.
- **T10** — Mastra remains invisible to consumers.
- **T11** — Executor is a Seqlane-owned abstraction.
- **T12** — `seqlane run` executes in a dedicated Node process.
- **T13** — oclif is launcher/supervisor/renderer only.
- **T14** — CLI ↔ runner communication uses Seqlane-owned structured messages.
- **T15** — V1 execution is autonomous and non-interactive.
- **T16** — Each Run gets a fresh runner process; no Seqlane daemon.

### OpenCode

- **T17** — OpenCode is the initial coding executor.
- **T18** — Repository harness interpretation remains OpenCode-owned.
- **T19** — Seqlane extensions are additive by default.
- **T20** — Native OpenCode capabilities remain native capabilities.
- **T21** — Capability collisions do not silently override.
- **T22** — Structured OpenCode output is revalidated by Seqlane.
- **T23** — Shared OpenCode sessions are serialized.
- **T24** — Managed, external-runtime, and existing-session modes are part of the full design.
- **T25** — MVP implements external runtime only; existing-session attachment is post-MVP.
- **T26** — Seqlane never implicitly broadens OpenCode permissions.

### Identity

- **T27** — Work, Run, and Invocation are distinct execution identities.
- **T28** — Work may span multiple Runs.
- **T29** — Static Task ID is descriptive, not sufficient for correlation.
- **T30** — Git provenance should eventually use Work/Run/Invocation identity.

## 39. Remaining Implementation Questions

The first implementation spikes must resolve:

1. `ValueRef<T>` implementation;
2. recursive `InputBinding<T>`;
3. Proxy vs alternative nested-ref mechanism;
4. workflow output inference;
5. schema abstraction;
6. Seqlane Plan → Mastra compiler;
7. workflow module loading;
8. TypeScript execution strategy inside the runner;
9. IPC serialization/error handling;
10. OpenCode server compatibility validation;
11. structured-output conversion and validation;
12. session creation and ownership details;
13. workflow discovery mechanics;
14. compile-time test infrastructure;
15. mock Executor/testing API.

Post-MVP work must additionally resolve branch and repeat typing, resource admission, effect-aware retries, full Harness Overlay implementation, managed OpenCode packaging/lifecycle, checkpoint/fork semantics, Work persistence and continuation, and Git provenance.

## Technical Architecture Statement

> **Seqlane is a TypeScript-native orchestration framework built around typed dataflow and a Seqlane-owned serializable Plan. Plans execute through an isolated runner using Mastra as a private workflow engine and Seqlane-owned executors, initially OpenCode. The runtime is autonomous, non-interactive, observable through structured events, and designed to evolve from single-run workflows toward bounded loops and multi-run logical Work without exposing its underlying execution engines to workflow authors.**

## Traceability

- [prd.seqlane: Seqlane](../prd/2026-09-02-seqlane.md)
- Replaced by [rfc.mastra-runtime-and-operational-foundation: Mastra as Seqlane's Runtime and Operational Foundation](./2026-09-03-mastra-runtime-and-operational-foundation.md).
