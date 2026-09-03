---
id: task.plan-node-addresses
title: Separate Plan-node addresses from execution identities
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.work-run-invocation-identity-model
supersedes: []
---

# Separate Plan-node addresses from execution identities

> Migrated from implementation story `TS-007-00`.

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

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.work-run-invocation-identity-model — Distinguish Work, Run, and Invocation Identity](../adrs/2026-09-02-work-run-invocation-identity-model.md)
- [spec.work-run-invocation-identity-model — Work, Run, and Invocation Identity Model](../specs/2026-09-02-work-run-invocation-identity-model.md)
- [spec.seqlane-plan-ir-typed-dataflow — Seqlane Plan IR and Typed Dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)

## Traceability

- [spec.work-run-invocation-identity-model](../specs/2026-09-02-work-run-invocation-identity-model.md)
