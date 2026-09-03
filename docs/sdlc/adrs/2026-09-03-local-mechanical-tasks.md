---
id: adr.local-mechanical-tasks
title: Run Local Mechanical Tasks Without an Agent
status: accepted
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - adr.executor-neutral-workflow-authoring
  - adr.effect-private-runtime-engine
  - adr.seqlane-plan-ir-and-typed-dataflow
  - adr.invocation-admission-and-workspace-coordination
  - adr.autonomous-non-interactive-execution
supersedes: []
---

# Run Local Mechanical Tasks Without an Agent

## Context

Seqlane currently resolves every task through an agent executor. This uses a
model session and tokens for work that a local program can do directly. Git
inspection, tests, formatters, and static analysis are examples.

Workflow authors need one task model for both agent work and local mechanical
work. A separate step concept would duplicate dataflow and lifecycle semantics.
Local work must use the same typed input and output contracts, dependencies,
workspace admission, cancellation, and execution events as agent work.

The runtime uses Effect as private execution infrastructure. Effect types must
not cross into core, Plans, workflow source, runner IPC, or events.

## Decision

`defineTask()` continues to define all Seqlane tasks. An agent task supplies a
`goal`. A local task supplies an `execute` function. A task must supply exactly
one of these fields.

```ts
const gitStatus = defineTask({
  id: "git-status",
  input: z.object({}),
  output: z.object({
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  workspace: "shared",
  execute: async (_input, { exec }) =>
    exec({ command: "git", args: ["status", "--porcelain=v1"] }),
});
```

The `execute` function receives a small Seqlane-owned task context. The first
context capability is `exec`. It runs one executable and an argument array in
the canonical workflow workspace. It returns the exit code and bounded
standard output/error. It does not invoke a shell.

Local task definitions stay in a runtime definition registry. The Plan stores
the task ID, task execution kind, input binding, dependencies, and workspace
policy. It never stores an `execute` callback, Effect object, child process, or
workspace path.

Local tasks return an output-only task handle. They do not create a model
session or a session checkpoint. They cannot use `session`, model selection, or
agent executor options. Local tasks do use workspace admission and generic
invocation events.

The runtime uses the installed Effect platform subprocess support only when it
can run direct argv, collect bounded output, handle cancellation, and wait for
process termination. If the private runtime cannot meet these requirements,
local task support stops until the runtime engine can provide them. A shell or
`node:child_process` fallback is not part of this decision.

## Alternatives considered

### Use an agent task for all work

This keeps one execution path. It wastes model tokens on deterministic work and
leaves Git and other command behavior dependent on model output. Rejected.

### Add a separate step abstraction

This separates agent and local work. It gives one workflow concern two public
names and two handle models. Rejected.

### Add local execution to the existing task abstraction

A task declares either an agent `goal` or a local `execute` function. Both task
types keep the same dataflow and lifecycle. Chosen.

### Run shell command strings

Shell strings make quoting, interpolation, cancellation, and input safety less
clear. They also make command injection easy. Rejected.

### Fall back to Node subprocess APIs

This would split subprocess lifecycle from the private runtime engine and is
not required by the current implementation. Rejected.

## Consequences

### Positive

- Deterministic work consumes no agent tokens.
- Workflows use one task vocabulary and one dataflow model.
- Git data can enter an agent task as typed output.
- Local task cancellation and workspace lifetime are explicit runtime behavior.
- Agent sessions remain limited to agent work.

### Negative

- The task contract is a discriminated union and Flow overloads must preserve
  the distinction.
- Effect platform packages add private runtime dependencies.
- Local `execute` functions are trusted workflow code.
- A local task that starts untracked external work can outlive the task.

## Follow-up constraints

- Keep Effect and Node subprocess types out of public contracts.
- Keep local callbacks, executable paths, argv, process handles, and workspace
  paths out of serialized Plans and runner IPC.
- Use direct executable and argv invocation. Do not add shell-string execution.
- Do not add `execa` for this work.
- Keep local tasks out of executor resolution, model preflight, session
  resolution, and token metrics.
- Hold the workspace lease until the local process stops.
- Keep V1 non-interactive. Do not add terminal input or approval prompts.

## Revisit conditions

Revisit this decision when Seqlane needs controlled shell support, sandboxing,
network policy, background local processes, or an Effect runtime migration.

## Traceability

- [adr.executor-neutral-workflow-authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
- [adr.effect-private-runtime-engine](./2026-09-02-effect-private-runtime-engine.md)
- [adr.seqlane-plan-ir-and-typed-dataflow](./2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)
- [adr.invocation-admission-and-workspace-coordination](./2026-09-02-invocation-admission-and-workspace-coordination.md)
- [adr.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md)
