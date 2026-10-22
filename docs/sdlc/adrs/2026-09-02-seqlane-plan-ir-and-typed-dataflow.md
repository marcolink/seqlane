---
id: adr.seqlane-plan-ir-and-typed-dataflow
title: Use a Seqlane-Owned Plan IR with Typed Dataflow
status: superseded
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - rfc.seqlane-technical-architecture
supersedes: []
---

# Use a Seqlane-Owned Plan IR with Typed Dataflow

> Superseded by [the current runtime architecture](../rfcs/2026-10-21-effect-v4-migration.md).
> Typed Plan ownership is retained by the current workflow specification.

## Context

Seqlane workflows must compose reusable tasks while preserving strong TypeScript types, explicit data dependencies, serializability, and independence from the internal workflow engine.

A workflow author should be able to wire one task's output into another task's input without separately declaring execution order.

Seqlane also needs a representation that can later support structured branching, loops, parallel policies, observability, and deterministic inspection.

Using runtime-library objects as the canonical workflow would couple the public programming model to an implementation API and state model.

## Decision

Seqlane will own a **serializable Plan intermediate representation (IR)**.

Workflow authoring builds this Plan before runtime execution.

The primary orchestration mechanism is **typed dataflow**:

```ts
const investigation = run(investigate, {
  input: {
    request: input.request,
  },
})

const plan = run(createPlan, {
  input: {
    investigation: investigation.output,
  },
})
```

The reference from `investigation.output` to `createPlan` implies:

```text
investigate → createPlan
```

Authors do not separately declare sequencing when it is already implied by data dependencies.

Task outputs are exposed through typed references such as:

```ts
result.output.files
// ValueRef<string[]>
```

Internally those references serialize to Seqlane-owned bindings such as:

```json
{
  "type": "ref",
  "invocation": "inv_123",
  "path": ["output", "files"]
}
```

The Plan is then validated and compiled into the internal execution engine:

```text
TypeScript workflow
       ↓
Seqlane Plan IR
       ↓
Seqlane validation
       ↓
Private Plan execution boundary
       ↓
Seqlane execution
```

## Plan Ownership

The Plan contains Seqlane concepts only.

It must not contain:

- runtime-library workflow or step objects;
- OpenCode SDK objects;
- runtime callbacks;
- raw executor state;
- ephemeral OpenCode session/message identifiers.

The MVP Plan needs only a static DAG subset.

The full Plan model may later include structured nodes such as:

```ts
type PlanNode =
  | TaskNode
  | BranchNode
  | RepeatNode
  | ParallelPolicyNode
```

Ordinary sequencing remains represented by dependency edges rather than explicit sequence nodes.

## Type-Safety Requirement

A reference must preserve the exact static type of the value it addresses.

If a task outputs:

```ts
z.object({
  files: z.array(z.string()),
  confidence: z.number(),
})
```

then:

```ts
result.output.files
```

must be assignable only where a `string[]`-compatible binding is accepted.

Incorrect wiring must fail during TypeScript compilation when the mismatch is statically knowable.

Runtime schema validation remains mandatory for external values.

## Consequences

### Positive

- Workflow structure is independent of runtime engines.
- Dependencies are derived from the data authors actually wire.
- The Plan can be serialized, inspected, tested, and observed.
- Parallelism can later be inferred from graph independence.
- Seqlane can preserve provenance at the binding level.
- Workflows and nested workflows can share one invocation model.
- Future runtime engines remain replaceable behind the compiler boundary.

### Negative

- Seqlane must implement Plan construction and validation.
- `ValueRef<T>` and recursive input binding types are non-trivial.
- Nested property references likely require a Proxy or equivalent mechanism.
- Structured control-flow types require careful graph-aware inference.
- The private runtime must interpret Seqlane Plan semantics.

## Alternatives Considered

### Runtime-library objects as the canonical workflow

Reduces compiler work but exposes implementation semantics and prevents Seqlane from owning a stable public model.

### Explicit `sequence()` / `parallel()` orchestration everywhere

Simpler runtime interpretation, but duplicates information already present in data dependencies.

### String-based references

Easy to serialize but sacrifices TypeScript safety and refactoring support.

### Shared workflow state/store

Convenient for cross-step access, but hides semantic dependencies and weakens graph/provenance inference.

## Constraints

- Plan construction must not execute tasks.
- Plan-building callbacks may construct structured nodes but may not become arbitrary runtime callbacks.
- External values are typed only after Seqlane runtime validation.
- The MVP may execute an independent DAG serially, but the Plan retains the true dependency graph.
- Seqlane's Plan remains the source of workflow semantics through every private runtime implementation.

## Decision Test

Reconsider this ADR if the required type system cannot remain ergonomic, serializable Plan construction makes normal TypeScript authoring impractical, or the compiler boundary prevents required runtime capabilities.

## Traceability

- [Replacement runtime architecture](../rfcs/2026-10-21-effect-v4-migration.md)
- [Current workflow semantics](../specs/2026-10-22-workflow-execution-semantics.md)

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [rfc.effect-v4-migration: Full Effect v4 Migration](../rfcs/2026-10-21-effect-v4-migration.md)
