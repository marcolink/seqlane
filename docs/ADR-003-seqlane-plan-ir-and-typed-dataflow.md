# ADR-003 — Use a Seqlane-Owned Plan IR with Typed Dataflow

**Status:** Implemented
**Scope:** Seqlane authoring model and runtime compilation
**Related:** RFC 1, Seqlane MVP

## Context

Seqlane workflows must compose reusable tasks while preserving strong TypeScript types, explicit data dependencies, serializability, and independence from the internal workflow engine.

A workflow author should be able to wire one task's output into another task's input without separately declaring execution order.

Seqlane also needs a representation that can later support structured branching, loops, parallel policies, observability, and deterministic inspection.

Using Mastra workflow objects directly as Seqlane's canonical representation would couple the public programming model to an implementation dependency and make Seqlane semantics dependent on Mastra's API and state model.

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
Seqlane → Mastra compiler
       ↓
Mastra execution
```

## Plan Ownership

The Plan contains Seqlane concepts only.

It must not contain:

- Mastra workflow or step objects;
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

- Workflow structure is independent of Mastra.
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
- A compiler layer must translate Seqlane semantics into Mastra semantics.

## Alternatives Considered

### Mastra workflow objects as the canonical workflow

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
- Seqlane's Plan remains the source of workflow semantics even when Mastra executes it.

## Decision Test

Reconsider this ADR if the required type system cannot remain ergonomic, serializable Plan construction makes normal TypeScript authoring impractical, or the compiler boundary prevents required runtime capabilities.
