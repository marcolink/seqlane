---
id: spec.seqlane-plan-ir-typed-dataflow
title: Seqlane Plan IR and Typed Dataflow
status: active
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - adr.seqlane-plan-ir-and-typed-dataflow
supersedes: []
---

# Seqlane Plan IR and Typed Dataflow

> Migrated from legacy technical specification `TS-003`.

## Objective

Deliver Seqlane's public, Mastra-independent authoring model for a static typed DAG. Authors define typed tasks, invoke them with literal and reference bindings, and receive a serializable `Plan` whose dependency edges are inferred from those bindings.

```text
typed workflow source
        ↓
Seqlane Plan IR
        ↓
Seqlane validation
        ↓
private Mastra compiler
```

## Invariants

- `@seqlane/core` owns all public authoring, task, binding, reference, workflow, and Plan contracts.
- Core exports no Mastra, OpenCode, Node process, executor implementation, or runtime callback type.
- A `Plan` contains only serializable Seqlane data. Task definitions, schemas, and callbacks stay with the in-memory workflow definition and never enter the Plan.
- The MVP Plan contains only `TaskNode`, literal bindings, reference bindings, dependency edges, and workflow output bindings.
- Building a Plan never executes a task.
- A task invocation's `output` is a `ValueRef<Output>`. Nested property access preserves the addressed static type.
- `run(task, { input })` accepts only an `InputBinding<Input>` and infers all task-output dependencies from references in the binding.
- The workflow input is represented internally by a Seqlane-owned root reference; it is not a task node or runtime value.
- Plan-node IDs are deterministic within one build and are unique even when a task is invoked more than once. They are static Plan addresses, not runtime Invocation IDs.
- Plan validation remains the runtime authority for malformed or externally supplied Plans. Authoring derives valid dependency edges; it does not weaken runtime validation.
- Existing hand-authored Plans remain supported during migration. The Renovate fixture becomes the representative typed-authoring example by the final story.

## Public Model

The core API provides generic task definitions, typed invocation results, `ValueRef<T>`, `InputBinding<T>`, and workflow definitions. A minimal authoring shape is:

```ts
const investigate = defineTask({
  id: "investigate",
  input: investigateInput,
  output: investigateOutput,
  goal: (input) => `Investigate ${input.request}`,
})

const remediation = defineWorkflow({
  id: "remediate",
  input: workflowInput,
  output: workflowOutput,
  build: ({ input, run }) => {
    const result = run(investigate, {
      input: { request: input.request },
    })

    return { output: { files: result.output.files } }
  },
})
```

The exact helper names may follow local TypeScript conventions, but the exported API must support this outcome without casts, manual generic arguments, string references, or separately declared dependencies.

`ValueRef<T>` serializes as a Seqlane-owned `{ type: "ref", nodeId, path }` binding. The path is relative to the referenced workflow input or Plan-node output. Runtime resolution retains that serialized interpretation; proxy behavior is authoring-only and must not leak into a Plan.

## Runtime Integration

The runtime receives a serialized `Plan` plus the in-memory task schema registry supplied by the workflow definition. It continues to resolve bindings, validate each task boundary, and compile only through its private Mastra integration. No public type or serialized object gains a Mastra field.

The runner loader accepts an authored workflow definition in addition to the existing Plan and Plan-factory compatibility forms. It builds and validates the Plan in the child process, preserving spec.dedicated-runner-process's process boundary.

## Type-Safety and Tests

Compile-time specification tests prove:

- nested `ValueRef<T>` property types;
- workflow-input references;
- literal and reference `InputBinding<T>` compatibility;
- rejection of statically incompatible wiring;
- workflow output inference; and
- repeated invocations and inferred dependency edges.

Runtime tests prove Plan serialization, deterministic Plan-node IDs, dependency inference, no task execution while building, runtime binding resolution, and the Renovate-shaped workflow contract.

## Out of Scope

- branches, repeats, foreach, explicit parallel policy, or dynamic scheduling;
- parallel execution;
- public Mastra, OpenCode, or executor APIs;
- arbitrary callbacks stored in a Plan;
- changing runner IPC payloads to transfer workflow definitions or Plans;
- persistent Plans, replay, or observability features beyond existing lifecycle data.

## Delivery Order

1. Public task and workflow contracts.
2. Typed references and bindings.
3. Plan construction with inferred dependencies.
4. Runtime loading and task-schema integration.
5. Renovate fixture migration and end-to-end contract proof.

## Traceability

- [adr.seqlane-plan-ir-and-typed-dataflow](../adrs/2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)
