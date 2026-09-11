---
id: task.reject-nested-workflows-in-repeats
title: Reject Nested Workflows in Repeat Bodies
status: planned
owners:
  - core
created: 2026-09-11
updated: 2026-09-11
upstream:
  - task.compose-workflows-as-runnables
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Reject Nested Workflows in Repeat Bodies

## Objective

Make the supported repeat contract consistent at authoring, Plan-validation,
and runtime boundaries. A repeat body containing a workflow invocation must be
rejected before execution instead of failing when the repeat dispatches it.

## Upstream requirements

- `SEQ-PR99-003`: Resolve the unsupported nested-workflow repeat path.
- `REQ-PLAN-002`: Reject malformed or unsupported Plan data with typed errors.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Scope

- Detect workflow invocation nodes in repeat bodies, including nested repeat
  bodies reached by validation and Plan traversal.
- Reject the composition during authoring and canonical Plan validation with a
  stable typed validation error.
- Keep a runtime defense-in-depth check for Plans received through private
  boundaries.
- Add authoring, malformed-Plan, and execution tests proving rejection occurs
  before repeat work starts.

## Out of scope

- Implementing workflow dispatch from repeat execution.
- New repeat or control-flow node kinds.
- Changes to general nested workflow execution outside repeat bodies.

## Implementation plan

1. Centralize the repeat-body capability check used by authoring and validation.
2. Add the typed rejection and runtime guard at the Plan-to-runtime boundary.
3. Add regression coverage for direct and recursively nested repeat bodies.
4. Update examples or contract documentation that implies unsupported support.

## Affected areas

- `libs/seqlane-core/`
- `libs/seqlane-runtime/`
- `libs/seqlane-fixtures/`

## Verification

Run `pnpm test:mapping` first. Then run focused core and runtime tests,
typechecks, and builds covering repeat validation and nested execution.

## Completion criteria

- No supported authoring path can create a repeat body with a workflow node.
- Direct Plan validation rejects the same shape with a stable typed error.
- Runtime input from a private boundary cannot reach repeat dispatch with that
  unsupported shape.
- Tests prove no repeat-body task starts before rejection.

## Outcome

Not delivered. This task records the follow-up for `SEQ-PR99-003`.

## Delivery state

Planned; no implementation or delivery evidence claimed.

## Traceability

- [task.compose-workflows-as-runnables: Compose Workflows as Runnables](./2026-09-08-compose-workflows-as-runnables.md)
- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
