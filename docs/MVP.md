# Seqlane MVP

**Status:** Draft  
**Depends on:** PRD, RFC 1  
**Purpose:** Define the minimum implementation required to prove Seqlane end-to-end.

## 1. MVP Thesis

The MVP must prove that a developer can:

> **Define reusable, strongly typed Seqlane tasks, compose them into a typed workflow using ordinary TypeScript, and execute that workflow autonomously from a CLI through a private runtime profile.**

The canonical real-world acceptance case is:

> **Fix a failed Renovate dependency update.**

## 2. Reference Use Case

The MVP must allow an internal Seqlane workflow that:

1. accepts information about a failed Renovate dependency update;
2. investigates the repository and failure;
3. produces a structured remediation plan;
4. modifies the repository to resolve the update;
5. verifies the resulting repository state;
6. returns a validated structured result.

```text
Renovate failure
       ↓
   investigate
       ↓
      plan
       ↓
   apply fix
       ↓
     verify
       ↓
structured result
```

All steps are generic Seqlane tasks. The MVP may use a private OpenCode adapter;
workflow source and Plans do not select or name that adapter.

## 3. User Experience

```bash
seqlane list

seqlane plan fix-renovate-update

seqlane run fix-renovate-update \
  --runtime local \
  --input '{
    "dependency": "some-package",
    "fromVersion": "1.0.0",
    "toVersion": "2.0.0",
    "failure": "Tests fail after update"
  }'
```

Execution:

```text
oclif CLI
   ↓
spawn dedicated runner
   ↓
load workflow
   ↓
build Seqlane Plan
   ↓
validate
   ↓
compile to Mastra
   ↓
connect to existing OpenCode server
   ↓
create OpenCode session
   ↓
execute tasks sequentially
   ↓
validate each structured output
   ↓
emit final result
   ↓
runner exits
```

There is no Seqlane server, UI, managed OpenCode lifecycle, persistence requirement, or interactive workflow behavior.

## 4. CLI Surface

MVP commands:

```text
seqlane list
seqlane plan <workflow>
seqlane run <workflow>
```

`list` shows discoverable workflows and scope. `plan` builds and validates a Plan without execution and may support `--json`. `run` executes the selected workflow and validates workflow input before execution.

## 5. Dedicated Runner Process

`seqlane run` executes workflow logic in a fresh foreground child Node process.

```text
┌──────────────────────────┐
│ oclif CLI                │
│ command parsing          │
│ workflow resolution      │
│ terminal rendering       │
│ signal forwarding        │
└────────────┬─────────────┘
             │ Node IPC
             ▼
┌──────────────────────────┐
│ Seqlane runner          │
│ workflow import          │
│ Plan construction        │
│ Mastra execution         │
│ OpenCode executor        │
│ schema validation        │
└────────────┬─────────────┘
             │ HTTP
             ▼
    Existing OpenCode
```

The runner is not detached, not persistent, and not reused between runs. The oclif parent is a launcher, supervisor, renderer, and signal forwarder only.

## 6. Autonomous Non-Interactive Execution

Once a run starts, the runner must execute the complete workflow independently.

No task may require user input, confirmations, permission decisions, or interactive CLI responses.

If execution requires unresolved human input or permission approval, the run fails deterministically.

The only runtime command the CLI needs after launch is cancellation.

## 7. Runner Protocol

Minimal commands:

```ts
type RunnerCommand =
  | {
      type: "run.start"
      workflow: WorkflowReference
      input: unknown
      opencode: {
        url: string
      }
    }
  | {
      type: "run.cancel"
    }
```

Minimal events:

```ts
type RunnerEvent =
  | { type: "run.started"; workId: string; runId: string }
  | { type: "invocation.started"; workId: string; runId: string; invocationId: string; taskId: string }
  | { type: "invocation.succeeded"; workId: string; runId: string; invocationId: string }
  | { type: "invocation.failed"; workId: string; runId: string; invocationId: string; error: SerializedSeqlaneError }
  | { type: "run.succeeded"; workId: string; runId: string; output: unknown }
  | { type: "run.failed"; workId: string; runId: string; error: SerializedSeqlaneError }
  | { type: "run.cancelled"; workId: string; runId: string }
```

No interactive request/response protocol is required.

## 8. External OpenCode Only

The MVP does not start or stop OpenCode. An OpenCode server must already be running.

Seqlane connects to it using a configured endpoint. Managed OpenCode remains part of the full RFC architecture, not the MVP.

## 9. OpenCode Session Model

The MVP supports one OpenCode session per Seqlane Run.

Default behavior creates a new session on the externally running server. All OpenCode tasks execute sequentially through this session.

Not MVP: attachment to an existing session, multiple named sessions, isolated sessions, session forks, checkpoint-based forks, or parallel session execution.

## 10. Repository OpenCode Harness

Existing OpenCode repository behavior remains authoritative.

Seqlane does not parse or recreate `AGENTS.md`, OpenCode configuration, repository skills, agents, tools, plugins, MCP, or repository instructions.

The MVP may add invocation-specific objective, instructions, textual/reference context, and output schema. Full native Harness Overlay materialization is deferred.

## 11. Initial Private Agent Adapter

The initial MVP profile may bind agent work to the private OpenCode adapter.

Local, HTTP, MCP, and Remote executors are deferred.

## 12. Strong Typing

Type safety is mandatory in the MVP.

Given:

```ts
const investigate = defineTask({
  id: "investigate",
  input: z.object({
    dependency: z.string(),
  }),
  output: z.object({
    files: z.array(z.string()),
    rootCause: z.string(),
  }),
  goal: ({ dependency }) => `Investigate ${dependency}`,
})
```

then:

```ts
const result = run(investigate, {
  input: {
    dependency: input.dependency,
  },
})

result.output.files
// ValueRef<string[]>
```

Incorrect task wiring must fail at compile time. Normal usage must not require casts or explicit generics to recover known types.

## 13. Runtime Validation

Every OpenCode task follows:

```text
OpenCode result
      ↓
structured output
      ↓
Seqlane schema validation
      ↓
typed Seqlane value
```

OpenCode-side structured-output validation does not replace Seqlane validation.

## 14. Static DAG Only

The MVP workflow model is a static typed DAG.

Supported:

- TaskNode;
- dependency edges;
- literal bindings;
- ValueRef bindings;
- workflow output bindings.

Not MVP: branch, repeat, foreach, explicit parallel policy, or dynamic scheduling.

## 15. Serial Execution

The MVP executes OpenCode invocations sequentially. The Plan may still preserve dataflow independence where nodes do not depend on each other.

## 16. Mastra

Mastra is used internally from the beginning.

```text
Seqlane Plan
      ↓
Seqlane → Mastra compiler
      ↓
Mastra
      ↓
OpenCode Executor
```

Mastra types and objects do not enter public APIs or IPC.

## 17. Repository and User Capabilities

The MVP supports basic discovery of workflows at repository and user scope.

Composition uses ordinary TypeScript imports. A task may be defined locally and used immediately without explicit registration.

Ambiguous discovered workflow names must not silently shadow each other.

Generated typed catalogs and reusable bundle distribution are deferred.

## 18. Minimal Configuration

Required runtime information is limited to:

- workflow;
- workflow input;
- OpenCode server endpoint.

No required Seqlane config file is necessary for the basic path.

Model profiles, resources, retry/effect policy, permission profiles, storage, observability, Mastra configuration, and full Harness Overlay configuration are deferred.

## 19. Model Selection

The MVP inherits model/agent behavior from the connected OpenCode environment. Seqlane model profiles are deferred.

## 20. Failure and Retry Behavior

Each invocation has one attempt. If an invocation fails, the workflow fails.

There are no automatic retries, particularly because OpenCode tasks may mutate repository state.

## 21. Cancellation

```text
CLI
 ↓
CancelRun IPC
 ↓
runner cancellation
 ↓
Mastra cancellation
 ↓
OpenCode abort
 ↓
runner cleanup
 ↓
exit
```

The externally managed OpenCode server remains alive.

## 22. Security Model

Seqlane/harness/workflow code is assumed to be trusted internal code.

MVP security principles:

- Seqlane does not implicitly increase executor authority.
- OpenCode execution policy must support autonomous execution.
- Seqlane does not ask the user to resolve permissions during a run.
- Sensitive execution data is not persisted unnecessarily.
- External OpenCode runtime/session compatibility is validated.
- Structured output validation establishes type integrity, not authorization.
- Mutating work is not automatically retried.
- External content is data, not execution authority.
- Untrusted-repository sandboxing is outside the MVP security profile.

## 23. Minimal CLI Output

Example:

```text
fix-renovate-update

→ investigate-renovate-failure
✓ investigate-renovate-failure

→ plan-renovate-fix
✓ plan-renovate-fix

→ apply-renovate-fix
✓ apply-renovate-fix

→ verify-renovate-fix
✓ verify-renovate-fix

✓ workflow completed
```

No persistent timeline or trace system is required.

Each fresh runner execution creates a new Work ID and Run ID. Work is not
selectable or continued across runs in the MVP; static Task and Plan-node IDs
remain descriptive and are not execution correlation identifiers.

## 24. Minimal Plan IR

Conceptually:

```ts
interface Plan {
  workflow: WorkflowIdentity
  nodes: TaskNode[]
  output: ValueBinding
}

interface TaskNode {
  nodeId: PlanNodeId
  task: TaskReference
  input: InputBinding
}

type ValueBinding =
  | LiteralBinding
  | ReferenceBinding
```

The IR must be Seqlane-owned and Mastra-independent.

## 25. MVP Packages

```text
@seqlane/core
@seqlane/runtime
@seqlane/opencode
seqlane
```

The core contains public contracts and Plan IR. Runtime contains Plan construction, Mastra integration, runner, cancellation, and executor routing. OpenCode contains external server/session integration and structured task execution. CLI contains oclif commands, runner spawning, rendering, signals, and exit codes.

## 26. Explicit MVP Exclusions

Not MVP:

- Seqlane-managed OpenCode startup/shutdown;
- automatic OpenCode installation;
- multiple OpenCode runtimes;
- multiple named sessions;
- isolated sessions;
- session forks/checkpoints;
- Seqlane model profiles;
- Seqlane-generated agents;
- native skill/tool/MCP overlay installation;
- Harness Overlay materialization;
- resource locks;
- effects;
- retries;
- concurrent task execution;
- branches;
- loops;
- foreach;
- non-OpenCode executors;
- GitHub Actions integration;
- persistent Run Records;
- OTEL/Datadog integration;
- replay;
- debugger/UI;
- reusable bundle distribution;
- generated typed catalogs;
- durable workflows;
- untrusted-code sandboxing;
- interactive workflows;
- ask-user/confirmation steps;
- interactive permission approval;
- pause/resume for human input;
- persistent Seqlane daemon;
- detached/background workflows;
- cross-run Work continuation;
- Git commit provenance.

## 27. MVP Success Criteria

The MVP is complete when:

1. TypeScript OpenCode tasks can be defined with typed input/output schemas.
2. Tasks can be defined locally without registration.
3. Existing tasks can be imported and reused.
4. Repository workflows can be discovered.
5. User workflows can be discovered.
6. Ambiguous workflow names do not silently shadow one another.
7. Multiple tasks can be composed into a workflow.
8. Nested `ValueRef<T>` property types are preserved.
9. Incorrect task wiring fails at compile time.
10. Workflow output is inferred.
11. A serializable Seqlane Plan is produced.
12. `seqlane plan` exposes that Plan.
13. The Plan is compiled internally through Mastra.
14. No Mastra type leaks into public APIs.
15. `seqlane run` executes workflow logic in a dedicated Node process.
16. The oclif parent contains no Mastra execution state.
17. The runner imports and builds the workflow itself.
18. The runner emits structured Seqlane lifecycle events.
19. Seqlane connects to an already-running OpenCode server.
20. Seqlane can create a single OpenCode session for the run.
21. Multiple OpenCode tasks execute sequentially through the same session.
22. Existing repository OpenCode harness behavior remains available.
23. Tasks can add invocation-specific instructions/context.
24. OpenCode returns structured results.
25. Seqlane independently validates every result.
26. Validated output becomes typed input for downstream tasks.
27. Workflow failures terminate execution cleanly.
28. Ctrl+C cancels active execution without terminating the external OpenCode server.
29. Seqlane does not automatically retry mutating operations.
30. Once started, a workflow requires no user interaction.
31. An unresolved OpenCode permission requirement fails rather than prompting.
32. Independent runs never reuse runner process state.
33. The complete failed Renovate update workflow runs end-to-end and successfully repairs at least one representative failed dependency update.

## MVP Boundary

> **Seqlane MVP is a non-interactive, CLI-triggered, TypeScript-native, fully type-safe static workflow runner. Each run executes autonomously in a dedicated Node process, uses Mastra internally, runs reusable OpenCode tasks sequentially through an externally managed OpenCode server, validates every task boundary, and can repair a failed Renovate dependency update from investigation through verification without human intervention.**
