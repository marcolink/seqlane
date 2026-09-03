---
id: task.local-task-plan-validation
title: Serialize and Validate Local Task Nodes
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.local-mechanical-tasks
supersedes: []
---

# Serialize and Validate Local Task Nodes

## Objective

As a workflow author, I can compose local tasks through typed dataflow without
putting executable callbacks or runtime state into a Plan.

## Upstream requirements

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [task.local-task-contracts](2026-09-03-local-task-contracts.md)

## Scope

- Task execution discriminator in core Plan types and builder lowering.
- Local task definition registry and repeat-body support.
- Plan validation, snapshot projection, and malformed-input coverage.
- Compatibility behavior for legacy task nodes without an execution
  discriminator.

## Out of scope

- Effect subprocess implementation and agent executor changes.

## Implementation plan

1. Add the serializable task execution discriminator.
2. Lower local definitions into JSON-safe Plan nodes and snapshots.
3. Validate the discriminator, registry kind, and local session restrictions.
4. Preserve legacy agent Plan compatibility.

## Affected areas

- `libs/seqlane-core/`
- `libs/seqlane-runtime/src/runtime/validation/`
- Plan snapshot and repeat-body projection

## Verification

- Builder and Plan tests cover local nodes without callbacks or process data.
- Validation rejects malformed execution kinds, wrong definition kinds, and
  local session declarations.
- Legacy agent nodes without an execution discriminator remain valid.

## Completion criteria

Local task Plans are JSON-safe, validate against the registered definition
kind, and remain compatible with existing agent Plans.

## Outcome

Plan serialization, definition registries, repeat-body support, validation,
snapshot projection, and malformed-input coverage were implemented in [PR #8](https://github.com/marcolink/seqlane/pull/8).

## Traceability

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [adr.local-mechanical-tasks](../adrs/2026-09-03-local-mechanical-tasks.md)
- [task.local-task-contracts](2026-09-03-local-task-contracts.md)
- [PR #8](https://github.com/marcolink/seqlane/pull/8)
