---
id: adr.exclusive-flow-choice
title: Route One Flow Branch Through an Exclusive Choice
status: accepted
owners:
  - core
created: 2026-09-26
updated: 2026-09-26
upstream:
  - prd.seqlane-on-mastra
  - adr.mastra-backed-seqlane-workflows
supersedes: []
---

# Route One Flow Branch Through an Exclusive Choice

## Context

Authors can compose tasks and bounded repeats, but cannot use a prior Boolean
result to select one of two runnables. An ordinary task cannot express this
choice without hiding the selected invocation inside its `execute` function.
The existing Mastra-backed workflow decision excluded generic conditionals from
its original delivery. This decision extends that Plan with one bounded choice.

## Decision

### decision-exclusive-flow-choice

`createFlow` gains this authoring chain:

```ts
.when(condition)
.task(name, trueRunnable, trueBinding)
.otherwise(falseRunnable, falseBinding)
```

`when` starts the choice and reads a typed Boolean reference to workflow input
or an earlier task output. The following `task` supplies the name and true
arm; it does not create a separate ordinary task node. `otherwise` is required
and supplies the false arm. Each arm invokes one ordinary task or child
workflow. A child workflow is the way to put multiple steps in an arm. Exactly
one arm executes; the other starts no work. The choice exposes the selected
arm's validated result through the task's existing named Flow output handle.

Both arms declare output schemas. The choice result has the union of their
inferred output types. The selected runnable parses its output once through its
own schema; the choice forwards that validated result. The workflow output
schema validates the final value. The choice itself is control flow, not a new
`TaskDefinition`, agent call, or executor. Each selected runnable retains its
task or workflow identity,
session policy, workspace policy, and invocation lifecycle. The choice has its
own inspectable Plan identity. The unselected arm is reported as not selected,
without failing the run or acquiring its execution resources.

The serializable Seqlane Plan gains a choice node. The private runtime lowers
it through Mastra workflow control flow and preserves Seqlane admission and
event contracts. Mastra types and callbacks do not enter the public DSL or
Plan. The runtime enforces exclusive selection even if its underlying branch
primitive permits several true conditions.

## Alternatives considered

### Add `defineConditionalTask`

Rejected. It would conceal the chosen task or workflow inside another task and
make its identity, policy, and execution path harder to inspect.

### Permit a runtime JavaScript predicate

Rejected. A predicate callback cannot be serialized in the Plan. Authors can
compute a Boolean with a normal deterministic task, then reference its output.

### Add an optional or many-way branch in the first delivery

Deferred. Required Boolean `then` and `else` arms give every successful choice
one output. More branch forms need their own output and selection contracts.

## Consequences

- Choice authoring, Plan validation, private compilation, snapshots, and run
  presentation gain a new node form.
- Both arms are statically known. Only the selected arm invokes work.
- A downstream task reads the choice output without referencing an arm that
  might not have run.
- Invalid condition values and malformed arm data fail with typed errors; they
  never select an implicit default. Downstream input and workflow output
  schemas validate the value they receive.

## Delivery state

Decision accepted on 2026-09-26. No implementation is claimed. Delivery is
tracked by the linked task.

## Traceability

- [prd.seqlane-on-mastra, exclusive choice requirement](../prd/2026-09-03-seqlane-on-mastra.md#requirement-exclusive-flow-choice)
- [adr.mastra-backed-seqlane-workflows](./2026-09-08-mastra-backed-seqlane-workflows.md)
- [spec.mastra-backed-seqlane-workflows, choice contract](../specs/2026-09-08-mastra-backed-seqlane-workflows.md#req-choice-001-route-one-runnable)
- [task.deliver-exclusive-flow-choice](../tasks/2026-09-26-deliver-exclusive-flow-choice.md)
