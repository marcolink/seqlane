# Tasks and data flow

A task has an ID, input schema, output schema, and execution function.
Seqlane validates inputs and outputs at each task boundary.

Observability includes full JSON inputs, results, and executor activity by
default. Task definitions have no `observability` field. The runtime does not
filter fields or truncate these values.

Use `defineTask` for deterministic TypeScript. A task can use
`context.runAgent()` when it needs an agent. Deterministic work makes no model
call unless its task function makes one.

Use `defineAgentTask` when a task only sends an agent goal. Read
[Agent tasks](/authoring-workflows/agent-tasks) for its contract and runtime
requirements.

Use `defineShellTask` for a local executable and argument list. Read
[Shell tasks](/authoring-workflows/shell-tasks) for process behavior and
failure handling.

Use `defineClassifierTask` for model classification. Read
[Classifier tasks](/authoring-workflows/classifier-tasks) for its question
contract and runtime requirements.

Each `.task()` binding callback can access the workflow input and outputs from
earlier task handles. Bind task input from `input`, a prior task output, or a
value that combines both.

```ts
.task("summarize", summarize, ({ input, tasks }) => ({
  pullRequest: input.pullRequest,
  status: tasks.status.output.stdout,
}))
```

The binding creates a data dependency. Declaration order does not.
