# TS-023 — Local Mechanical Tasks

**Status:** Implemented
**Implements:** ADR-023
**Depends on:** ADR-003, ADR-005, ADR-008, ADR-019, ADR-020, ADR-021

## 1. Objective

Add local task execution for deterministic work that does not require an agent
or consume model tokens. Keep one public task vocabulary and preserve Seqlane's
typed dataflow, event, cancellation, and workspace contracts.

## 2. Normative Terms

- **Agent task:** A task that defines `goal` and runs through an agent executor.
- **Local task:** A task that defines `execute` and runs in the Seqlane process.
- **Task context:** The Seqlane-owned value passed to a local task function.
- **Command request:** One executable name and an ordered argv array.
- **Effect v3 gate:** The required subprocess behavior that Effect v3 platform
  support must provide before this work can continue.

## 3. Invariants

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

## 4. Effect v3 Feasibility Gate

Before public contracts or runtime execution code are added, evaluate the
installed `effect@3.22.1` with the matching Effect platform Node package.

The evaluation passes only when a small private prototype proves all items:

1. Run an executable with an argv array without a shell.
2. Set the process current directory from the runtime workspace.
3. Collect separate standard output and standard error with byte limits.
4. Return the exit code after both streams close.
5. Interrupt the process from the invocation `AbortSignal`.
6. Wait for child termination before the Effect scope and workspace lease close.
7. Map spawn, stream, exit, and interruption errors to typed Seqlane errors.

Run the dependency security preflight before adding Effect platform packages.

If any item fails because Effect v3 cannot provide it, stop TS-023. Do not add a
`node:child_process` implementation. Create and deliver an Effect v4 migration
first. Resume TS-023 only after that migration is complete.

## 5. Public Contracts

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
mixed `goal` and `execute` definitions at compile time and at runtime loading.
`.task()` must return an agent handle for agent definitions and an output-only
handle for local definitions. Local task options omit `session`.

`TaskContext.exec()` is intentionally small. It does not expose a child process,
Effect service, workspace path, environment mutation, shell, or background API.

## 6. Plan and Validation Contracts

Task nodes keep `type: "task"` and serialize an execution discriminator:

```ts
type TaskExecution = "agent" | "local";
```

The Plan stores `taskId`, `execution`, `nodeId`, `workspace`, `input`, and
`dependsOn`. It does not store the task definition or executable request.

The built workflow keeps separate agent and local task-definition registries, or
one discriminated registry. Plan validation checks that each node execution kind
matches its registered definition. It rejects malformed execution kinds, local
session declarations, and local nodes without a matching definition.

Repeat body contracts and Plan snapshots include local task nodes from the first
delivery.

## 7. Runtime Contracts

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

## 8. Events and Errors

Local tasks use existing `invocation.started`, `invocation.progress`,
`invocation.input`, `invocation.result`, `invocation.succeeded`,
`invocation.failed`, and `invocation.cancelled` events. They use the existing
task subject shape. Local task results contain no token or model metrics.

Spawn errors, interruption errors, output-limit errors, and invalid outputs
become typed invocation errors. The error retains the original cause. Event
output and error diagnostics remain bounded.

## 9. Compatibility and Exclusions

Existing `goal` task definitions keep their current behavior. Existing Plans
without `execution` are legacy agent task nodes.

This work does not add shell strings, `execa`, command allowlists, Git helper
APIs, terminal interaction, process trees, environment configuration, network
policy, sandboxing, background processes, retries, or parallel execution.

## 10. Verification Gate

Each story must pass its mapped scoped tests, then the full gate:

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
