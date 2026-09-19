# Dependencies

Seqlane detects dependencies from each `.task()` input binding. A task-output
reference in a binding creates a dependency on that task.

```ts
.task("inspect", inspect, ({ input }) => ({
  repository: input.repository,
}))
.task("summarize", summarize, ({ input, tasks }) => ({
  repository: input.repository,
  findings: tasks.inspect.output.findings,
}))
```

`summarize` depends on `inspect` because its binding reads
`tasks.inspect.output.findings`. References can be in objects or arrays.
Seqlane reads the complete binding.

Workflow input references, such as `input.repository`, do not create a task
dependency. Task declaration order also does not create a dependency.

Use `dependsOn` only when a task must wait for another task but does not use
its output.

```ts
.task("prepare", prepare, ({ input }) => input)
.task("publish", publish, ({ input }) => input, {
  dependsOn: ["prepare"],
})
```

Session reuse and branching also create dependencies. A reused or branched
session waits for its source task.

A child workflow is also a task target. Read
[Workflow composition](/authoring-workflows/workflow-composition) for reusable
workflow units.
