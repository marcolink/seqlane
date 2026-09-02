# ADR-001 — Use Mastra as Seqlane’s Internal Workflow Engine

**Status:** Superseded by ADR-019
**Scope:** Future Seqlane in-process runtime
**Related:** RFC 1, Seqlane MVP, TS-001

## Context

The current repository is a foundation-only monorepo. It does not build or deploy a service, and this ADR does not introduce a service boundary, HTTP server, infrastructure, Terraform, or service-kit dependency.

When runtime implementation begins, Seqlane will require an execution engine capable of running workflow graphs and eventually supporting sequencing, concurrency, branching, loops, cancellation, and retries.

Seqlane could implement these mechanics itself, but doing so would create substantial runtime complexity unrelated to Seqlane’s primary differentiation: its TypeScript authoring model, typed dataflow, executor abstraction, repository-aware workflows, and observability model.

## Decision

Seqlane will use **Mastra as its internal workflow execution engine**.

```text
Task / Workflow API
        ↓
Seqlane Plan IR
        ↓
Seqlane → Mastra compiler
        ↓
Mastra workflow
        ↓
Seqlane executor wrapper
        ↓
Executor
```

Mastra is a **private in-process runtime dependency**. It is not a separately deployed service.

No Mastra types, workflow objects, errors, configuration, lifecycle APIs, or terminology may appear in Seqlane’s public API or serialized Plan.

`@seqlane/core` must not depend on Mastra. The dependency belongs in `@seqlane/runtime`.

## Consequences

### Positive

- Seqlane does not need to build basic workflow execution mechanics.
- Future Seqlane control-flow constructs can compile to corresponding Mastra execution primitives.
- Mastra can evolve independently behind the Seqlane Plan/compiler boundary.
- Seqlane remains free to own its data model, type system, executor semantics, identity, and observability.

### Negative

- Seqlane inherits a significant runtime dependency.
- Seqlane must maintain a compiler/adapter boundary.
- Mastra behavior and upgrades require compatibility testing.
- Some Mastra capabilities will intentionally remain unavailable until Seqlane defines corresponding semantics.

## Constraints

Seqlane must **not** use Mastra workflow state as its canonical dataflow model.

Seqlane must **not** expose Mastra suspend/resume as a Seqlane feature merely because Mastra supports it. Seqlane V1 is autonomous and non-interactive.

Seqlane decides retry safety. MVP retries remain disabled even if the underlying engine supports them.

## Alternatives Considered

### Custom Seqlane runtime

Maximum control but substantial implementation and maintenance cost.

### Effect

Strong TypeScript runtime foundation, but Seqlane would still need to build most workflow mechanics.

### XState

Capable state-machine runtime, but Seqlane is dataflow-first rather than state-machine-first.

### Trigger.dev / external orchestration

Stronger infrastructure assumptions than desired for a local, single-process developer workflow runtime.

## Decision Test

Reconsider this ADR if:

- Mastra materially prevents implementation of Seqlane’s Plan semantics;
- Mastra leaks into the public API despite the compiler boundary;
- runtime size or performance becomes prohibitive;
- maintaining the adapter costs more than owning the required runtime functionality.
