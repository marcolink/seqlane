# Repetition

Use `.until()` after `.task()` for a bounded post-condition loop. The task runs
at least once. After each attempt, Seqlane evaluates `until`. It starts another
attempt only when that condition is false.

```ts
.task("repair", repair, ({ input }) => input)
.until(({ result }) => result.complete, {
  maxIterations: 3,
  nextInput: ({ result }) => result,
})
```

If you omit `nextInput`, each attempt uses the first input. If the task has an
output validator, Seqlane validates each attempt before it evaluates `until`.
