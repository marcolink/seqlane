---
id: adr.fluent-seqlane-flow-dsl
title: Provide a Fluent Seqlane Flow DSL
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Provide a Fluent Seqlane Flow DSL

## Context

Seqlane authors now define a workflow with a `build` callback and call `run`
for each task invocation. This API creates a typed, static DAG. It does not
give authors one clear surface for task names, output selection, and the final
Plan.

Mastra provides a fluent workflow DSL. A similar Seqlane surface can make
workflow definitions easier to read. Seqlane cannot expose Mastra types or
use Mastra workflow objects as its public model.

Seqlane is dataflow-first. A task reference creates a dependency. A fluent
call order must not create a dependency by itself. A `.then()`-only DSL makes
the Seqlane model look like a linear pipeline. It also cannot express fan-out,
fan-in, or independent tasks clearly.

## Decision

Seqlane will provide a fluent, Seqlane-owned Flow DSL in
`@seqlane/core`.

The DSL will construct the existing Seqlane Plan IR. It will not construct or
return a Mastra workflow.

The DSL will provide these authoring operations:

- `createFlow` defines the workflow identity and input/output schemas.
- `.task(name, definition, bindings)` adds one named task invocation.
- Bindings receive typed workflow-input and prior-task output references.
- `.repeat(name, options)` adds a bounded conditioned loop.
- `.output(bindings)` defines the final typed workflow value.
- `.define()` returns a normal `WorkflowDefinition` through the existing
  Seqlane contracts.

### Task model scope

The MVP uses one Seqlane task type: an agent-oriented task. Seqlane does not
introduce public `PromptTask`, `GithubTask`, or other provider/domain task
types. `defineTask` remains the single authoring factory, with `goal`,
optional `instructions`, and optional `references` describing the requested
agent work. These fields are executor-neutral; the private runtime selects the
adapter.

Non-agent work is deferred until a concrete product requirement requires it.
If that requirement arrives, it must first be evaluated as an extension of the
same `TaskDefinition` contract. A GitHub integration must not add GitHub types
to `seqlane-core`.

### Named handles

Each `.task()` and `.repeat()` name must be a unique string literal. The name
adds a type-safe key to the `tasks` object in later builder callbacks. The key
contains a typed output handle, not a task result. An unknown or duplicate name
is a TypeScript error.

Names are authoring-only aliases. They do not change task IDs, Plan-node IDs,
or runtime invocation IDs.

`.output()` is not a task invocation. It creates no Plan node and no dependency
edge. It only defines `Plan.output`, which the runtime resolves after all
referenced tasks complete. After `.output()`, the completed builder exposes
only `.define()`.

The method order improves readability only. Dependencies come only from
`ValueRef` values in the bindings. Top-level task dependencies remain a static
DAG.

The Flow DSL adds a Seqlane-owned `RepeatNode` for a conditioned loop. The
Plan is otherwise a static DAG. A loop body is a static subplan that the
runtime can invoke more than once.

The following examples show the intended authoring shape. Exact helper types
will be defined in the implementation specification.

### Supported connection types

The first DSL release supports the following connection types:

- Workflow input to a task input.
- A whole task output to a task input.
- A nested task-output property to a task input.
- Literal values mixed with input and task-output references.
- Fan-out from one task to multiple tasks.
- Fan-in from multiple tasks to one task.
- Independent tasks that use only literals or workflow input.
- Repeated invocation of one task definition through different task names.
- Final output aggregation with `.output()`.

This example uses all supported connection types. Task definitions and schemas
are omitted for brevity.

```ts
export const repositoryReport = createFlow({
  id: "repository-report",
  input: repositoryReportInputSchema,
  output: repositoryReportOutputSchema,
})
  // Workflow input → task input.
  .task("repository", readRepositoryTask, ({ input }) => ({
    repository: input.repository,
  }))
  // Whole output. This also starts fan-out from "repository".
  .task("analysis", analyzeRepositoryTask, ({ tasks }) =>
    tasks.repository.output,
  )
  // Nested output, workflow input, and a literal in one binding.
  .task("unit", runSuiteTask, ({ input, tasks }) => ({
    repository: input.repository,
    baseBranch: tasks.repository.output.baseBranch,
    suite: "unit",
  }))
  // A second invocation of "runSuiteTask" and another fan-out consumer.
  .task("integration", runSuiteTask, ({ input, tasks }) => ({
    repository: input.repository,
    baseBranch: tasks.repository.output.baseBranch,
    suite: "integration",
  }))
  // Literal-only input. This task is independent of every earlier task.
  .task("policy", loadPolicyTask, () => ({ version: "v1" }))
  // Fan-in from analysis, both suite invocations, and the independent task.
  .task("report", createReportTask, ({ tasks }) => ({
    analysis: tasks.analysis.output,
    unitPassed: tasks.unit.output.passed,
    integrationPassed: tasks.integration.output.passed,
    policy: tasks.policy.output,
  }))
  // Final aggregation. This does not invoke another task.
  .output(({ tasks }) => ({
    repository: tasks.repository.output,
    report: tasks.report.output,
  }))
  .define();
```

### Conditioned loop

The first DSL release includes a bounded, post-condition loop. The loop body
runs once before Seqlane reads the condition. Seqlane stops when the
condition is `true`. Otherwise, it supplies the body output to the next
iteration.

The initial value and each body result must use the same state schema. The
condition callback must return a `ValueRef<boolean>` from the body result. A
JavaScript predicate is not allowed because the Plan must serialize the
condition. `maximumIterations` is required and must be a positive integer.

The loop result is a named handle. It can bind a later task input or the final
workflow output. Iterations are sequential. When the last iteration does not
meet the condition, Seqlane fails the run with a Seqlane-owned loop-limit
error.

```ts
export const repairWorkflow = createFlow({
  id: "repair-until-verified",
  input: repairInputSchema,
  output: repairStateSchema,
})
  .repeat("repair", {
    initial: ({ input }) => ({
      repository: input.repository,
      passed: false,
    }),
    body: ({ input, task }) => {
      const change = task(applyRepairTask, { input });
      const verification = task(verifyRepairTask, {
        input: {
          repository: input.repository,
          change: change.output,
        },
      });

      // `verification.output` has the same RepairState schema as `input`.
      return verification.output;
    },
    until: ({ output }) => output.passed,
    maximumIterations: 3,
  })
  .output(({ tasks }) => tasks.repair.output)
  .define();
```

`parallel`, `branch`, and `foreach` are not part of the first DSL release.
They require Seqlane-owned Plan semantics and runtime behavior. Later helpers
must compile to Seqlane Plan nodes. They must not pass through Mastra
control-flow objects.

### Result lifetime

The `tasks` object exists only while Seqlane builds the Plan. It contains
`ValueRef` handles and never contains runtime output values.

At runtime, Seqlane retains a task result until its final Plan consumer and
the final workflow output resolve. It then removes the result from the private
execution context.

A loop retains only its current state, active body results, and final result.
It does not retain prior iteration values only for loop execution. Events can
contain output summaries. A persistent output policy must use dedicated
storage, not the execution-context result map.

## Options Considered

### Keep the current `build` and `run` API only

This API is correct and small. It does not give authors a named fluent surface
or an obvious place for the final workflow output. This option is rejected.

### Copy Mastra's DSL and public types

This reduces short-term API design work. It exposes a private runtime engine
and makes Seqlane behavior depend on Mastra. This option is rejected.

### Use a `.then()` pipeline DSL

This reads well for linear flows. It makes call order look like a dependency
and does not describe a DAG with fan-in or independent tasks. This option is
rejected.

### Defer conditioned loops

This preserves the static-DAG MVP. It prevents bounded repair and verification
flows that must repeat until a typed result meets a condition. This option is
rejected.

### Use a fluent Seqlane-owned graph builder

This keeps the API familiar while making data references the only dependency
source. It permits named task handles and a Seqlane-owned loop node.
This option is chosen.

## Consequences

### Positive

- Workflow definitions have one readable authoring surface.
- Named task handles make fan-in and final output bindings clear.
- The DSL retains typed `ValueRef` bindings and inferred dependencies.
- Existing task and executor resolution remain unchanged outside loop nodes.
- The DSL can add further Seqlane-owned control-flow helpers after their semantics
  are defined.
- A bounded loop can express repair and verification work without an executor
  callback or hidden runtime state.
- Authoring contexts do not retain task outputs.
- Runtime memory does not grow with completed loop iterations.

### Negative

- The core type system must track task names and output types across builder
  calls.
- The DSL adds a second public authoring form during migration.
- Fluent syntax can hide dataflow rules if the API documentation is weak.
- The core Plan, validation, runtime compiler, events, and output renderer
  must support repeated body invocations.
- The runtime must calculate result lifetimes for task and loop outputs.

## Required Follow-up

Before implementation, create spec.fluent-seqlane-flow-dsl and implementation stories that define:

- TypeScript inference for named task handles and nested output references.
- Literal task-name errors, duplicate-name errors, and deterministic Plan-node
  IDs.
- Compatibility between the Flow DSL and `defineWorkflow` / `buildWorkflow`.
- Type and runtime tests for every required connection form.
- Type-check performance tests for a large fluent flow.
- `RepeatNode` serialization, validation, runtime lowering, and loop-limit
  failure behavior.
- Typed loop state, post-condition bindings, sequential iterations, and
  per-iteration invocation identities.
- Result-lifetime analysis for DAG and loop outputs, including final-output
  retention and output release.
- Migration guidance for existing workflow definitions.

## Constraints

- `seqlane-core` must not import or expose Mastra or executor types.
- A Flow DSL definition must build only Seqlane-owned serializable Plan data.
- Flow construction must not execute a task or executor callback.
- A binding reference remains the sole source of a static dependency edge.
- A serialized Plan must not contain the authoring callbacks.
- A task or loop name must be a unique string literal.
- The authoring `tasks` object must contain handles, never task results.
- The runtime must release a result after its final consumer and final-output
  use complete.
- A loop condition must be a serializable boolean reference from its body.
- Each loop must have a finite positive `maximumIterations` value.
- A loop body cannot schedule parallel iterations in the first DSL release.
- A loop must not retain prior iteration results only for loop execution.
- The DSL must use declared package exports across package boundaries.

## Revisit Conditions

Revisit this ADR if fluent typing makes normal workflows difficult to write, if
named handles cannot preserve type-safe dataflow, or if structured control flow
requires a different Plan model.

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
