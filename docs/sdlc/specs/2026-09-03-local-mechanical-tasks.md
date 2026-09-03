---
id: spec.local-mechanical-tasks
title: Local Mechanical Tasks
status: active
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - adr.local-mechanical-tasks
  - spec.executor-neutral-workflow-authoring
  - spec.effect-runtime-integration
  - spec.seqlane-plan-ir-typed-dataflow
  - spec.invocation-admission-and-workspace-coordination
  - spec.autonomous-non-interactive-execution
supersedes: []
---

# Local Mechanical Tasks

## Summary

Add local task execution for deterministic work that does not require an agent
or consume model tokens. Keep one public task vocabulary and preserve Seqlane's
typed dataflow, event, cancellation, and workspace contracts.

## Normative terms

- **Agent task:** A task that defines `goal` and runs through an agent executor.
- **Local task:** A task that defines `execute` and runs in the Seqlane process.
- **Task context:** The Seqlane-owned value passed to a local task function.
- **Command request:** One executable name and an ordered argv array.
- **Subprocess gate:** The required subprocess behavior that the private Effect
  platform support must provide before local tasks can continue.

## Invariants

- A task defines exactly one of `goal` or `execute`.
- `createFlow().task()` composes both task types.
- Local task handles expose `output` and no `session` checkpoint.
- A local task Plan node is JSON-safe and never serializes the callback.
- Local task execution does not resolve an agent executor, model, or session.
- A local task uses the canonical runtime workspace as its current directory.
- `exec` runs direct argv and never parses a shell string.
- A local process completes, fails, or terminates before its task releases the
  workspace lease.
- Standard output and standard error have bounded capture.
- Local tasks emit generic invocation events and no model metrics.
- V1 supports foreground, non-interactive commands only.

## Subprocess feasibility gate

Before public contracts or runtime execution code are added, evaluate the
installed Effect platform with the matching private runtime dependencies.

The evaluation passes only when a small private prototype proves all items:

1. Run an executable with an argv array without a shell.
2. Set the process current directory from the runtime workspace.
3. Collect separate standard output and standard error with byte limits.
4. Return the exit code after both streams close.
5. Interrupt the process from the invocation `AbortSignal`.
6. Wait for child termination before the Effect scope and workspace lease close.
7. Map spawn, stream, exit, and interruption errors to typed Seqlane errors.

Run the dependency security preflight before adding private platform packages.
If any item cannot be met, stop this delivery and make the runtime engine
support the required behavior before resuming. Do not use a subprocess fallback
for this delivery.

## Public contracts

`@seqlane/core` owns the authoring types. It does not import Effect or Node.

```ts
interface TaskExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface TaskContext {
  exec(request: {
    readonly command: string;
    readonly args?: readonly string[];
  }): Promise<TaskExecResult>;
}

interface LocalTaskDefinition<Input, Output> {
  readonly id: TaskId;
  readonly input: SeqlaneSchema<Input>;
  readonly output: SeqlaneSchema<Output>;
  readonly workspace?: WorkspacePolicy;
  readonly execute: (input: Input, context: TaskContext) => Promise<Output>;
}
```

The final shape may use a discriminated union or overloads. It must reject
mixed and missing task behavior at compile time and runtime loading. `.task()`
must return an agent handle for agent definitions and an output-only handle for
local definitions. Local task options omit `session`.

## Plan and validation contracts

Task nodes keep `type: "task"` and serialize an execution discriminator:

```ts
type TaskExecution = "agent" | "local";
```

The Plan stores `taskId`, `execution`, `nodeId`, `workspace`, `input`, and
`dependsOn`. It does not store the task definition or executable request.

The built workflow keeps separate agent and local task-definition registries,
or one discriminated registry. Plan validation checks that each node execution
kind matches its registered definition. It rejects malformed execution kinds,
local session declarations, and local nodes without a matching definition.

Repeat body contracts and Plan snapshots include local task nodes from the first
delivery.

## Runtime contracts

The compiler dispatches local task nodes to a dedicated local-task invocation
path. This path reuses existing binding resolution, schema parsing, workspace
admission, generic events, result retention, and typed invocation failure.

The path does not call executor lookup, model preflight, session preflight, or
checkpoint publication.

The runtime provides `TaskContext.exec()` only during one local invocation. Its
Effect implementation has one scoped child process per call. The process uses
the canonical workspace as `cwd`, the invocation signal for interruption, and
bounded stream collection. A non-zero exit is returned to the local task. The
task decides if that exit is an expected result or an error.

The initial implementation supports only foreground processes. `execute` must
await `exec`. A future background-process API requires a separate decision.

## Events and errors

Local tasks use existing `invocation.started`, `invocation.progress`,
`invocation.input`, `invocation.result`, `invocation.succeeded`,
`invocation.failed`, and `invocation.cancelled` events. They use the existing
task subject shape. Local task results contain no token or model metrics.

Spawn errors, interruption errors, output-limit errors, and invalid outputs
become typed invocation errors. The error retains the original cause. Event
output and error diagnostics remain bounded.

## Compatibility and exclusions

Existing `goal` task definitions keep their current behavior. Existing Plans
without `execution` are legacy agent task nodes.

This work does not add shell strings, `execa`, command allowlists, Git helper
APIs, terminal interaction, process trees, environment configuration, network
policy, sandboxing, background processes, retries, or parallel execution.

## Verification gate

Each task must pass its mapped scoped tests, then the full gate:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm format:check
pnpm exec nx sync:check
git diff --check
```

## Traceability

- [adr.local-mechanical-tasks](../adrs/2026-09-03-local-mechanical-tasks.md)
- [spec.executor-neutral-workflow-authoring](2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.effect-runtime-integration](2026-09-02-effect-runtime-integration.md)
- [spec.seqlane-plan-ir-typed-dataflow](2026-09-02-seqlane-plan-ir-typed-dataflow.md)
- [spec.invocation-admission-and-workspace-coordination](2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.autonomous-non-interactive-execution](2026-09-02-autonomous-non-interactive-execution.md)
