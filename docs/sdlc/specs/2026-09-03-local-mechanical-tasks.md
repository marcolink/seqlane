---
id: spec.local-mechanical-tasks
title: In-Process and Shell Mechanical Tasks
status: active
owners:
  - core
created: 2026-09-03
updated: 2026-09-09
upstream:
  - adr.mastra-local-mechanical-tasks
  - spec.mastra-backed-seqlane-workflows
  - spec.executor-neutral-workflow-authoring
  - spec.mastra-runtime-and-operational-integration
  - spec.seqlane-plan-ir-typed-dataflow
  - spec.invocation-admission-and-workspace-coordination
  - spec.autonomous-non-interactive-execution
supersedes: []
---

# In-Process and Shell Mechanical Tasks

## Summary

Add deterministic in-process and shell task execution. Neither task kind
requires an agent or consumes model tokens. Keep one public task vocabulary and
preserve Seqlane's typed dataflow, runner notification, cancellation, and
workspace contracts.

This specification uses **in-process task** for a `defineTask` implementation
that computes in the Seqlane process. It is not a separate public task type.

## Normative terms

- **Agent factory:** `defineAgentTask` is a convenience factory that produces
  an ordinary executable task whose implementation calls
  `TaskContext.runAgent()`.
- **In-process task:** A `defineTask` callback that executes in the Seqlane
  process. It can compute directly and can use `TaskContext.exec()` when it
  needs a process.
- **Shell task:** A `defineShellTask` task that starts exactly one external
  executable with an argv array. It does not run an arbitrary callback.
- **Command request:** One executable name and an ordered argv array.
- **Subprocess gate:** The required subprocess behavior that Mastra's local
  workspace or sandbox process support must provide for task process execution.

## Invariants

- Every completed task definition has the foundational `execute` contract.
- Specialized factories supply `execute` and reject caller-supplied `execute`.
- `createFlow().task()` composes all executable tasks through one task contract.
- Session and workspace policy belong to the workflow invocation, not the task
  definition.
- A task Plan node is JSON-safe and never serializes the callback.
- A task uses the invocation's admitted canonical runtime workspace as its
  current directory.
- A shell task runs one executable with direct argv and never parses a shell
  string.
- A shell process must terminate before its task releases the workspace lease.
  If termination cannot be confirmed, the runtime quarantines the lease.
- Standard output and standard error have bounded capture.
- In-process tasks emit bounded runner notifications and observability data without
  model metrics.
- V1 supports foreground, non-interactive commands only.

## Subprocess contract

Before public contracts or runtime execution code are added, evaluate the
pinned Mastra Workspace or Sandbox process API with the matching private
runtime dependencies.

The runtime must prove all items:

1. Run an executable with an argv array without a shell.
2. Set the process current directory from the runtime workspace.
3. Collect separate standard output and standard error with byte limits.
4. Return the exit code after both streams close.
5. Interrupt the process from the invocation `AbortSignal`.
6. Wait for child termination before the runtime scope and workspace lease
   close.
7. Map spawn, stream, exit, and interruption errors to typed Seqlane errors.

Run the dependency security preflight before adding private Mastra packages. If
any item cannot be met, stop this delivery and make the Mastra runtime support
the required behavior before resuming. Do not add an Effect or Node subprocess
fallback for this delivery.

## Public contracts

`@seqlane/core` owns the authoring types. It does not import Node or runtime
engine types.

```ts
const gitStatus = defineShellTask({
  id: "git-status",
  input: z.object({}),
  executable: "git",
  argv: () => ["status", "--porcelain=v1"],
});
```

`defineShellTask` infers its input type from its Zod input schema and returns
the canonical `shellTaskResultSchema` output type: `{ exitCode, stdout,
stderr }`. Its input omits `execute`, `cwd`, environment values, output
transforms, and shell options. The factory supplies the foundational `execute`
implementation. A non-zero exit code remains output data; a later task or
validation gate decides what it means for the workflow.

## Plan and validation contracts

Task nodes keep `type: "task"`. The Plan stores `taskId`, `nodeId`, workspace
policy, input, session policy when supported, and `dependsOn`. It does not store
an execution discriminator, task definition, callback, or executable request.

The in-memory registry keeps executable definitions. Runtime validation applies
declared workspace and session policy before calling `execute`; it also rejects
nodes without a matching definition. The task's use of `TaskContext.exec()` or
`TaskContext.runAgent()` does not create a separate Plan node kind.

Repeat body contracts and Plan snapshots include in-process task nodes from the first
delivery.

## Runtime contracts

The task runtime path reuses existing binding resolution, schema parsing,
workspace admission, generic events, result retention, and typed invocation
failure. The runtime provides `TaskContext` only during one invocation. Its
process operation has one child process per call and uses the canonical
workspace as `cwd`, the invocation signal for interruption, and bounded stream
collection. An agent operation uses the invocation's resolved session when one
was declared. A non-zero exit is returned to the task. The task decides if that
exit is an expected result or an error.

The Mastra Plan compiler dispatches every task through the same executable
task path after invocation policy admission. Repeat support remains outside
this migration slice.

The initial implementation supports only foreground processes. A future
background-process API requires a separate decision.

## Notifications and errors

Tasks use the core-owned runner protocol and the bounded observability
projection. A task that does not call `TaskContext.runAgent()` produces no
token or model metrics.

Spawn, timeout, interruption, output-limit, uncertain-termination, and invalid
output errors become typed invocation errors. Domain errors retain the cause.
Serialized errors and diagnostics omit the cause and remain bounded.

## Compatibility and exclusions

Existing `goal` task definitions migrate to `defineAgentTask`. Existing in-process
definitions stay on `defineTask`. Existing command tasks migrate to
`defineShellTask`. Workflows rebuild their Plans with no compatibility alias.

This work does not add shell strings, `execa`, command allowlists, Git helper
APIs, terminal interaction, network policy, sandboxing, background processes,
retries, or a general shell or environment API. Independent workflow nodes can
execute concurrently under the active Mastra eligibility and Seqlane admission
rules.

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

- [adr.mastra-local-mechanical-tasks](../adrs/2026-09-04-mastra-local-mechanical-tasks.md)
- [spec.executor-neutral-workflow-authoring](2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.mastra-runtime-and-operational-integration](2026-09-03-mastra-runtime-and-operational-integration.md)
- [spec.seqlane-plan-ir-typed-dataflow](2026-09-02-seqlane-plan-ir-typed-dataflow.md)
- [spec.mastra-backed-seqlane-workflows](2026-09-08-mastra-backed-seqlane-workflows.md)
- [spec.invocation-admission-and-workspace-coordination](2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.autonomous-non-interactive-execution](2026-09-02-autonomous-non-interactive-execution.md)
