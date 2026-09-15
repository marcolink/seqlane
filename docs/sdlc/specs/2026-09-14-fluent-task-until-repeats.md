---
id: spec.fluent-task-until-repeats
title: Fluent Task-Until Repeats
status: active
owners:
  - core
created: 2026-09-14
updated: 2026-09-15
upstream:
  - prd.seqlane-on-mastra
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Fluent Task-Until Repeats

## Summary

A workflow author can repeat one task or child workflow with
`.task(...).until(...)`. The runnable executes once before Seqlane checks its
result. It repeats until a typed boolean result is true or a required iteration
limit is reached. The author can bind the next attempt's input from the current
input and result.

This specification extends the single `createFlow` authoring API and replaces
the former `.repeat(name, options)` authoring shape. Its active status defines
the implementation contract, not proof of runtime delivery.

## Goals

- Make a single task and a reusable child workflow equally easy to repeat.
- Keep the first input, each attempt result, and the next input independently
typed. Do not require the first input to contain a placeholder result. Let a
later input reuse the initial input or bind values from earlier Flow tasks.
- Keep the stop condition and next-input binding in the serializable Seqlane
  Plan. Keep Mastra and executor types out of the public API.
- Preserve the existing bounded-repeat limits, typed errors, admission rules,
  cancellation, and inspectable invocations.

## Non-goals

- Looping all earlier Flow nodes or adding an implicit execution-order edge.
- Automatic retry after a task error, implicit semantic repair, or backoff.
- General conditional branching, `foreach`, unbounded loops, or parallel
  iterations.
- A second runtime loop engine or persistent Seqlane run store.

## Terminology

- **Attempt runnable:** the task or child workflow named by `.task()`.
- **Initial input:** the bound input supplied to the first attempt.
- **Attempt input:** the input supplied to the current attempt.
- **Attempt result:** the validated output of the current attempt.
- **Stop condition:** a `ValueRef<boolean>` selected from the attempt result or
  an earlier Flow task.
- **Next-input binding:** an authoring-time binding from the current attempt
  input and result to the next attempt input.

## Requirements

### requirement-single-fluent-loop

The only public repeat authoring shape is `.task(...).until(...)` within
`createFlow`. `.until()` applies only to the immediately preceding `.task()`.
The named task becomes one repeat node; it is not also executed as a separate
ordinary task node. The named handle retains the attempt runnable's output
type and refers to the final successful result.

An attempt runnable can be a task or an authored child workflow. A child
workflow can contain multiple typed invocations and keeps its own session and
workspace policies. Authors compose a multi-step attempt with the normal
`createFlow` API, not a repeat-specific body builder.

### requirement-typed-loop-data

The existing `.task(name, runnable, binding, options)` binding supplies the
initial input. The runnable's input and output schemas may differ. The
`until` binding can read the attempt result and earlier Flow task handles. It
must return a `ValueRef<boolean>`. Seqlane evaluates that reference after each
successful attempt, including the first.

`nextInput` is optional. When present, it binds the current attempt input,
result, and earlier Flow task handles to the runnable's input type. Seqlane
evaluates it only after a false stop condition. When absent, every attempt
receives the original initial input. No result-to-input conversion occurs
implicitly.

The `until` and `nextInput` contexts expose earlier task handles through
`tasks`, consistent with other Flow bindings. They exclude the repeated task's
own handle and any later task. The stop condition can select a boolean from
the current attempt result or an earlier task. An earlier task's output does
not change between attempts. References to earlier tasks in either callback
become explicit Plan dependencies and resolve from their completed outputs on
each attempt.

The `until` and `nextInput` callbacks run only while building the Plan. Their
returned references and bindings are serialized; their JavaScript functions
are not. A changing computed condition or next input needs an explicit
deterministic task inside the attempt workflow.

### requirement-bounded-execution

`maxIterations` is required and is a finite integer from 1 through 1,000.
The attempt runnable runs at least once. A true condition on the last allowed
attempt succeeds. A false condition on that attempt fails with the existing
typed `LoopLimitExceededError` and retains the last attempt's bounded
diagnostic evidence. The run-wide limit remains 1,000 repeat-body executions;
the next attempted execution fails with `RunRepeatLimitExceededError` before
the runnable starts.

Task failure stops the repeat. Seqlane does not retry it. Cancellation stops
the active attempt and prevents another attempt. No later workflow node can
consume a repeat result after failure or cancellation.

### requirement-mastra-lowering

The private compiler lowers the repeat to Mastra-native post-condition loop
control flow. If input and output shapes differ, private mapping steps or a
private loop envelope adapt them without changing the public schema or adding
a Seqlane-owned executor loop. The compiler enforces the iteration limit with
Mastra's iteration count and normalizes limit errors to Seqlane's typed errors.
The installed Mastra version's types and a focused runtime test must confirm
the exact lowering before implementation.

Every attempt and child invocation remains inspectable. The existing
dependency, session, workspace, identity, cancellation, and observability
contracts apply on each attempt. A repeated child workflow uses the same
preflight and admission as an ordinary child workflow invocation. Broader
nested-workflow workspace-admission hardening is separate work.

## Detailed design or contracts

The proposed call site is:

```ts
const workflow = createFlow({ id, input: workflowInput, output: resultSchema })
  .task("repair", repairAttemptWorkflow, ({ input }) => ({
    repository: input.repository,
    feedback: null,
  }))
  .until(({ result }) => result.verified, {
    maxIterations: 3,
    nextInput: ({ input, result }) => ({
      repository: input.repository,
      feedback: result.feedback,
    }),
  })
  .output(({ tasks }) => tasks.repair.output)
  .define();
```

The example assumes `repairAttemptWorkflow` accepts `{ repository,
feedback }` and returns a result with `verified` and `feedback` fields. The
current attempt input and result have separate types. The return from
`nextInput` must validate against the runnable's input schema before another
attempt starts.

The private Mastra lowering stores repeat data in the loop workflow's native
`stateSchema`. Initial input, current input, workflow input, dependency
results, and the latest result are stored once in that Mastra-owned state.
Each persisted attempt envelope contains only JSON-safe control data: the
attempt number, stop flag, run identity, repeat budget, and an explicit loop
workflow/run reference. The envelope is bounded to 16 KiB and is validated
before persistence. If Mastra resumes the internal loop, it restores both the
envelope and state through the same attempt boundary. This design does not add
a public Seqlane suspend or resume API, or a second result store.

The type-level contract is:

```ts
interface UntilContext<TaskOutput, Handles> {
  readonly result: ValueRef<TaskOutput>;
  readonly tasks: Handles;
}

interface NextInputContext<TaskInput, TaskOutput, Handles> {
  readonly input: ValueRef<TaskInput>;
  readonly result: ValueRef<TaskOutput>;
  readonly tasks: Handles;
}

interface UntilOptions<TaskInput, TaskOutput, Handles> {
  readonly maxIterations: number;
  readonly nextInput?: (
    context: NextInputContext<TaskInput, TaskOutput, Handles>,
  ) => InputBinding<TaskInput>;
}

until(
  condition: (context: UntilContext<TaskOutput, Handles>) => ValueRef<boolean>,
  options: UntilOptions<TaskInput, TaskOutput, Handles>,
): FlowBuilderWithHandle<TaskOutput>;
```

`FlowBuilderWithHandle` denotes the existing builder with the named handle.
The concrete generic type can differ, but it must keep the current handle and
binding inference. The `.until()` method is available only on the builder
returned by a `.task()` call and is consumed by that immediate chain.

The serializable repeat node records the runnable kind and registry key, its
initial input binding, stop-condition reference, optional next-input binding,
and iteration limit. It records no authoring callback or Mastra object.
References inside the repeat are scoped to the attempt input and result.
Outer dependencies come from the initial task binding, declared policies, and
earlier task references in `until` or `nextInput`.

## Failure and edge cases

- Reject `.until()` without an immediately preceding task declaration at
  TypeScript authoring time. Reject malformed private Plan input before work
  starts.
- Reject a condition that does not reference a boolean value from the attempt
  result or an earlier task. Reject references outside the current attempt or
  earlier task scope.
- Reject non-integer, non-finite, zero, negative, or over-1,000 limits before
  execution.
- Parse each attempt input and result with the runnable's Zod schemas. A bad
  next input fails before another attempt starts.
- Preserve the original cause when normalizing task, validation, admission,
  cancellation, and loop-limit failures.
- A child workflow's failure stops the repeat. A child workflow inside a
  repeat is a supported contract. The conflicting rejection task was
  cancelled and superseded by the task that delivers this spec.

## Migration

This is a breaking change to authoring. Remove `.repeat(name, options)` and
its repeat-body mini-DSL when `.task().until()` is delivered. Do not keep a
second public repeat API or a legacy runtime path. Update examples, fixtures,
public declarations, and authoring documentation in the same delivery.

The active Mastra-backed workflow specification retains the general Plan,
policy, and repeat limits. Its authoring and repeat clauses reflect this
contract. The new delivery task supersedes the cancelled
`task.reject-nested-workflows-in-repeats`. Completed earlier repeat tasks
remain historical records, not open work for this design.

## Verification

- Run the test-mapping check before focused tests.
- Typecheck valid task and child-workflow call sites, invalid conditions,
  invalid next-input types, and use of `.until()` away from a `.task()`.
- Test serialized Plan validation and malformed or out-of-scope references.
- Test reuse of the initial input without `nextInput`, and earlier task
  references in `nextInput` with their dependency ordering.
- Run focused real-Mastra tests for one attempt, later success, exact-limit
  success, per-node exhaustion, the run-wide budget, different input and
  output schemas, child workflow attempts, cancellation, and admission.
- Test JSON snapshot reload and resumed attempts, including bounded control
  envelopes and durable dependency results.
- Check public declarations for Mastra type leaks and source for forbidden
  `/ee/` imports.

## Acceptance criteria

- An author uses `.task(...).until(...)` for both a single task and a
  multi-step child workflow with no second repeat authoring path.
- The first attempt uses the task binding. A later attempt uses `nextInput`
  only after a false condition; without it, the initial input is reused.
- Every attempt has a validated input and result, an inspectable identity,
  and the normal session and workspace admission behavior.
- The last allowed successful attempt completes. A false last condition and
  run-wide budget exhaustion fail with their respective typed errors.
- The normal CLI and operational host execute the same Mastra-backed repeat
  semantics; cancellation prevents any later attempt.

## Delivery state

Active contract. The feature branch implements `.task(...).until(...)` through
Mastra. This status does not claim delivery on the target branch.

## Traceability

- [prd.seqlane-on-mastra: Seqlane on Mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](./2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.reject-nested-workflows-in-repeats: Reject Nested Workflows in Repeat Bodies](../tasks/2026-09-11-reject-nested-workflows-in-repeats.md)
- [task.deliver-fluent-task-until-repeats: Deliver Fluent Task-Until Repeats](../tasks/2026-09-14-deliver-fluent-task-until-repeats.md)
