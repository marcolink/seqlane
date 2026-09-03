---
id: spec.mastra-runtime-integration
title: Mastra Runtime Integration
status: superseded
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - adr.mastra-internal-workflow-engine
supersedes: []
---

# Mastra Runtime Integration

> Migrated from legacy technical specification `TS-001`.

> **Superseded:** [spec.effect-runtime-integration](./2026-09-02-effect-runtime-integration.md) replaces
> the private Mastra runtime with Effect.

## 1. Objective

Implement the minimum Seqlane → Mastra integration required to execute an MVP static DAG while preserving Seqlane as the authoritative workflow model.

```text
Seqlane Plan
     ↓
deterministic topological ordering
     ↓
Mastra sequential workflow
     ↓
Seqlane executor steps
```

The Plan may represent independent nodes, but the MVP executes them serially.

## 2. Design Principle

Mastra is the **execution scheduler**, not Seqlane’s data model.

Seqlane retains ownership of:

- workflow input;
- input bindings;
- task outputs;
- `ValueRef` semantics;
- dependency graph;
- validation;
- executor routing;
- Seqlane identities;
- Seqlane events.

Seqlane should avoid translating its semantic data model into Mastra workflow state.

## 3. Runtime Components

```text
Seqlane runner
    │
    ├── Plan
    ├── ExecutionContext
    │      ├── workflowInput
    │      ├── results Map<PlanNodeId, unknown>
    │      ├── executors
    │      └── event sink
    │
    └── MastraCompiler
             │
             ▼
       committed Mastra workflow
```

The compiler lives in `@seqlane/runtime`.

Suggested internal modules:

```text
runtime/
  mastra/
    compile-plan.ts
    compile-task-node.ts
    run-mastra-plan.ts
    errors.ts
```

## 4. Mastra Dependency

Import only the workflow surface required by Seqlane.

Conceptually:

```ts
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows"
```

No Mastra dependency is allowed in `seqlane-core`, `seqlane-opencode`, workflow author source, Plan IR, or runner IPC contracts.

## 5. ExecutionContext

Each Seqlane Run creates one internal context:

```ts
interface ExecutionContext {
  workId: WorkId
  runId: RunId
  workflowInput: unknown

  results: Map<PlanNodeId, unknown>

  executors: ExecutorRegistry

  events: {
    emit(event: SeqlaneEvent): void
  }
}
```

This object exists only inside the runner process. It is not serialized into the Plan and is not exposed publicly.

## 6. Compilation Algorithm

Given:

```text
A
↓
B
↓
C
```

or an MVP Plan containing independent nodes:

```text
   A
  ↙ ↘
 B   C
```

the compiler:

1. validates the Plan;
2. performs a deterministic topological sort;
3. creates one Mastra step per Seqlane `TaskNode`;
4. chains those steps sequentially;
5. adds a synthetic Seqlane result step;
6. commits the workflow.

For the second example, the MVP may compile `A → B → C` while preserving the original DAG in the Seqlane Plan.

Later compiler versions can lower richer Seqlane Plan nodes onto Mastra parallel, branch, and loop primitives without changing the authoring API.

## 7. Internal Step Envelope

Mastra should **not** become responsible for carrying Seqlane task values between steps.

Generated Mastra steps should use a minimal internal envelope, for example:

```ts
const stepEnvelope = z.object({
  nodeId: z.string(),
})
```

Each generated step ignores the previous task’s semantic output.

Seqlane values are resolved from `ExecutionContext.workflowInput` and `ExecutionContext.results`.

This keeps Seqlane `ValueRef` semantics independent from Mastra step input semantics.

## 8. Generated Task Step

Conceptually:

```ts
function compileTaskNode(
  node: TaskNode,
  context: ExecutionContext,
) {
  return createStep({
    id: node.nodeId,
    inputSchema: stepEnvelope,
    outputSchema: stepEnvelope,

    execute: async ({ abortSignal }) => {
      context.events.emit({
        type: "invocation.started",
        workId: context.workId,
        runId: context.runId,
        invocationId: context.invocationIds.get(node.nodeId),
        taskId: node.taskId,
      })

      try {
        const input = resolveBindings(
          node.input,
          context.workflowInput,
          context.results,
        )

        const validatedInput = node.task.input.parse(input)
        const executor = context.executors.get(node.executor)

        const rawOutput = await executor.execute({
          invocationId: context.invocationIds.get(node.nodeId),
          task: node.task,
          input: validatedInput,
          signal: abortSignal,
        })

        const output = node.task.output.parse(rawOutput)
        context.results.set(node.nodeId, output)

        context.events.emit({
          type: "invocation.succeeded",
          workId: context.workId,
          runId: context.runId,
          invocationId: context.invocationIds.get(node.nodeId),
        })

        return { nodeId: node.nodeId }
      } catch (cause) {
        const error = toSeqlaneInvocationError(cause)

        context.events.emit({
          type: "invocation.failed",
          workId: context.workId,
          runId: context.runId,
          invocationId: context.invocationIds.get(node.nodeId),
          error,
        })

        throw error
      }
    },
  })
}
```

The exact adapter code may change with the installed Mastra API, but the ownership boundary above is normative.

## 9. Binding Resolution

`resolveBindings()` is entirely Seqlane-owned.

A reference may be represented internally as:

```ts
{
  type: "ref",
  nodeId: "investigate:1",
  path: ["output", "plan"],
}
```

Resolution performs:

```text
binding
  ↓
workflow input / results Map
  ↓
property traversal
  ↓
resolved JS value
  ↓
task input validation
```

Mastra does not interpret `ValueRef`.

## 10. Workflow Result

Seqlane workflow output may not equal the output of the final task.

Compile a synthetic finalization step:

```text
tasks...
   ↓
__seqlane_result
```

It resolves the Plan’s output bindings from `ExecutionContext`, validates the workflow output schema, stores the final result in the run context, and returns the internal step envelope.

The Seqlane runtime returns the stored Seqlane result rather than exposing Mastra’s final step result.

## 11. Running the Compiled Workflow

The runtime creates and starts a Mastra run using the installed workflow API.

Seqlane does not use Mastra’s stream as its public observability protocol. Invocation wrappers emit Seqlane-owned events directly.

## 12. Result Mapping

```text
Mastra success
      ↓
Seqlane workflow output
      ↓
RunSucceeded

Mastra failure
      ↓
Seqlane error normalization
      ↓
RunFailed
```

If Mastra exposes execution states Seqlane did not intentionally request, V1 treats them as unsupported runtime states and fails deterministically.

No Mastra result type is exposed to consumers.

## 13. Cancellation

The runner retains the active Mastra Run instance. On `CancelRun`, the runtime cancels the Mastra run.

The cancellation signal must propagate into the generated step and then into the Seqlane Executor.

```text
SIGINT
 ↓
CLI
 ↓
CancelRun
 ↓
Mastra cancellation
 ↓
step AbortSignal
 ↓
Seqlane Executor
 ↓
OpenCode abort
```

## 14. Retries

Generated Mastra steps have no automatic retry policy in the MVP.

Seqlane intentionally does not enable retries until effect-aware retry semantics are implemented.

```text
one Seqlane Invocation
=
one Executor attempt
```

for MVP.

## 15. Suspend/Resume

Seqlane does not invoke suspend/resume or equivalent persisted workflow features in the MVP.

These conflict with the MVP’s one-process autonomous execution profile and remain hidden behind the Seqlane boundary.

## 16. Mastra State

Do not use Mastra workflow state for task outputs, workflow bindings, Seqlane Run identity, executor state, or session state.

Mastra state may only be introduced later through a dedicated design decision if the compiler genuinely requires it.

## 17. Error Boundary

All exceptions leaving a generated step must first be normalized into a Seqlane error.

Conceptually:

```ts
SeqlaneError
  ├── InputValidationError
  ├── ExecutorError
  ├── OutputValidationError
  └── RuntimeError
```

Mastra errors may be retained internally as `cause`, but cannot cross runtime → IPC without Seqlane normalization.

## 18. Tests

### Compiler unit tests

Verify deterministic topological ordering, one generated step per TaskNode, synthetic result step, and invalid Plan rejection.

### Runtime unit tests

Using a fake Executor, verify binding resolution, result storage, input/output validation, executor errors, and Seqlane event emission.

### Mastra integration tests

Use the real Mastra package to prove compiled workflow execution, expected step order, downstream stop on failure, and cancellation propagation.

### Contract test

A Renovate-shaped fixture:

```text
investigate
   ↓
plan
   ↓
fix
   ↓
verify
```

must execute through real Mastra with mocked OpenCode execution.

## 19. Acceptance Criteria

spec.mastra-runtime-integration is complete when:

- `seqlane-core` has no Mastra dependency;
- a static Seqlane Plan compiles to a committed Mastra workflow;
- Seqlane task values are resolved independently of Mastra state;
- a fake executor can run a multi-step Plan;
- task input and output are validated by Seqlane;
- Seqlane lifecycle events are emitted independently of Mastra events;
- failure stops downstream execution;
- cancellation reaches the active executor;
- automatic Mastra retries are disabled;
- no Mastra object/type reaches workflow authors, IPC, or final results;
- the MVP Renovate-shaped workflow executes end-to-end through this runtime.

## 20. Explicitly Deferred

spec.mastra-runtime-integration does not implement parallel Plan lowering, BranchNode lowering, RepeatNode lowering, foreach, Mastra persistence, suspend/resume, Seqlane retries, Mastra Studio, Mastra telemetry as Seqlane telemetry, or durable execution.

## Traceability

- [adr.mastra-internal-workflow-engine](../adrs/2026-09-02-mastra-internal-workflow-engine.md)
