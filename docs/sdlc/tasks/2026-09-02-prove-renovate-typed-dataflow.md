---
id: task.prove-renovate-typed-dataflow
title: Prove the Renovate typed-dataflow contract
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.seqlane-plan-ir-typed-dataflow
supersedes: []
---

# Prove the Renovate typed-dataflow contract

> Migrated from implementation story `TS-003-04`.

## Use Case

**As a** Seqlane maintainer, **I want to** express the representative Renovate workflow through the typed authoring API, **so that** the MVP proves the whole Plan IR path rather than a hand-built fixture only.

## Scope

- Migrate the Renovate fixture from hand-authored TaskNodes to the typed task/workflow API.
- Preserve its existing runtime, failure, cancellation, and CLI contract coverage.
- Add direct assertions for typed Plan shape, output bindings, and inferred dependencies.
- Review package-local docs for public contract drift.

## Out of Scope

- A real OpenCode server or executor.
- New workflow discovery behavior.
- Branches, loops, retries, parallel execution, or persisted Plans.

## Implementation Notes

The fixture retains a test-only executor seam and its intended package export. It defines `investigate → plan → fix → verify` through references such as `investigation.output`, proving that schemas, plan construction, runtime validation, and private compilation cooperate end to end.

## Acceptance Criteria

**Scenario:** *Representative workflow uses typed dataflow*
- **Given:** The Renovate fixture defines its four task stages
- **When:** Its workflow Plan is built
- **Then:** Its dependency edges and output bindings are inferred from typed references rather than hand-authored node arrays

**Scenario:** *Representative workflow still executes*
- **Given:** The fixture's fake executor and runner contract tests
- **When:** The workflow runs through the existing runtime and CLI boundary
- **Then:** Success, failure, and cancellation retain their established behavior

**Scenario:** *Authoring contract is documented accurately*
- **Given:** The final public API and fixture behavior
- **When:** nearby package documentation is reviewed
- **Then:** docs describe the supported core-owned Plan IR and no stale manual-authoring claim remains

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.seqlane-plan-ir-and-typed-dataflow — Use a Seqlane-Owned Plan IR with Typed Dataflow](../adrs/2026-09-02-seqlane-plan-ir-and-typed-dataflow.md)
- [spec.seqlane-plan-ir-typed-dataflow — Seqlane Plan IR and Typed Dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)

## Traceability

- [spec.seqlane-plan-ir-typed-dataflow](../specs/2026-09-02-seqlane-plan-ir-typed-dataflow.md)
