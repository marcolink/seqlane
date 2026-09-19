# Sessions

Session policy controls the task history for an agent task. Declare it on the
task invocation, not on the task definition.

## Choose a session

Select a session for the context that a task needs.

::: info Isolated session

Use `isolated()` when a task needs no earlier agent history.

:::

::: info Reused session

Use `reuse(source.session)` when a task must continue the source context.

:::

::: info Branched session

Use `branch(source.session)` when a task needs the source context but can
continue independently.

:::

Tasks that use the same session never run in parallel. A branch uses a separate
session, so it can run independently after its source task completes.

`isolated()` starts a new session. It has no history from another task.

`reuse(source.session)` continues the exact source session. The reused task
waits for its source task.

`branch(source.session)` starts a child session from a source checkpoint. It
has the source history but can continue independently.

```ts
.task("implement", implement, ({ input }) => input, {
  session: isolated(),
})
.task("review", review, ({ tasks }) => tasks.implement.output, {
  session: ({ tasks }) => reuse(tasks.implement.session),
})
.task("security", reviewSecurity, ({ tasks }) => tasks.implement.output, {
  session: ({ tasks }) => branch(tasks.implement.session),
})
```

Branching requires an adapter that can create a native checkpoint fork. Seqlane
stops the run when the adapter cannot provide that capability.
