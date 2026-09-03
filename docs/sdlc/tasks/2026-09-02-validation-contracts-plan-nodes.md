---
id: task.validation-contracts-plan-nodes
title: Add Validation Contracts, Plan Nodes, and Registries
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.semantic-validation-gates
supersedes: []
---

# Add Validation Contracts, Plan Nodes, and Registries

> Migrated from implementation story `TS-015-00`.

## User outcome

As a workflow author, I can define typed semantic validation contracts that
remain independent of Mastra and concrete executors.

## Scope

- Add `ValidationResult`, `ValidationIssue`, validator definitions, and
  evaluator task types to `seqlane-core`.
- Add validation check/gate Plan nodes and `ValidationInvocation` handles.
- Add validator registry collection to `BuiltWorkflow`.
- Add `ValidationFailedError` with `ValidationError` category.

## Out of scope

- Runtime execution.
- Flow lowering and repeat postconditions.
- Runner protocol and output projections.
- Retry, recovery, approval, or validator composition.

## Implementation notes

- Keep callbacks and evaluator definitions outside serialized Plans.
- Validator IDs are unique registry identities; Flow names are separate local
  handle names.
- Duplicate validator IDs fail during workflow build.

## Acceptance criteria

**Scenario:** *A validation result is typed and JSON-safe*

- **Given:** A validator returns a result
- **When:** The result is typed
- **Then:** success is the only control-flow field, failed results contain at
  least one issue, and evidence is JSON-safe

**Scenario:** *A Plan contains no validator callbacks*

- **Given:** A workflow uses a mechanical validator
- **When:** The workflow is built
- **Then:** The Plan contains only validator identity, bindings, policy, and
  dependencies

**Scenario:** *Duplicate validator IDs are rejected*

- **Given:** Two definitions use the same validator ID
- **When:** The workflow is built
- **Then:** Build fails with a duplicate registry identity error

## Source

- [adr.semantic-validation-gates](../adrs/2026-09-02-semantic-validation-gates.md)
- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)

## Traceability

- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
