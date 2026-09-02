# TS-007-00 — Separate Plan-node addresses from execution identities

**Status:** completed

## User Outcome

**As a** workflow author, **I want** a Plan reference to identify a static node only, **so that** it cannot be mistaken for a concrete execution identity.

## Scope

- Add a distinct core `PlanNodeId` contract.
- Rename/migrate serialized `TaskNode`, `ValueBinding`, `ValueRef`, dependency, Plan validation, and binding-resolution fields from execution-named IDs to Plan-node addresses.
- Update typed workflow build results and core/runtime tests to use Plan-node addresses.
- Preserve deterministic, unique node addresses within one Plan build.

## Out of Scope

- Work, Run, or runtime Invocation allocation.
- Lifecycle event or runner IPC field changes.
- Cross-run continuation, persistence, Git provenance, or CLI options.

## Implementation Notes

Use a breaking migration; do not retain an `invocationId` compatibility alias in serialized Plan data or public authoring results. Runtime binding/result maps still key by the static address in this story. Execution identity is introduced only after this Plan boundary is unambiguous.

## Acceptance Criteria

**Scenario:** *A Plan contains static node addresses only*
- **Given:** A typed workflow is built
- **When:** Its Plan is serialized
- **Then:** every task node, dependency edge, and value reference uses `PlanNodeId`, and the Plan contains no Work, Run, or runtime Invocation identity

**Scenario:** *Repeated task definitions remain distinguishable in one Plan*
- **Given:** A workflow invokes the same Task definition more than once
- **When:** the Plan is built
- **Then:** each resulting node has a distinct deterministic Plan-node address and bindings resolve through that address

**Scenario:** *Core keeps its public boundary*
- **Given:** a consumer imports the core authoring API
- **When:** it builds a Plan
- **Then:** it needs no runtime, Mastra, executor, or ID-generation import

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-007 — Distinguish Work, Run, and Invocation Identity](../../ADR-007-work-run-invocation-identity-model.md)
- [TS-007 — Work, Run, and Invocation Identity Model](../../TS-007-work-run-invocation-identity-model.md)
- [TS-003 — Seqlane Plan IR and Typed Dataflow](../../TS-003-seqlane-plan-ir-typed-dataflow.md)
