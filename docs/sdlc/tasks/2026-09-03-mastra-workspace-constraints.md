---
id: task.mastra-workspace-constraints
title: Lower Workspace Constraints Into the Mastra Graph
status: planned
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Lower Workspace Constraints Into the Mastra Graph

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-session-semantics](./2026-09-03-mastra-session-semantics.md)

## Delivery

- Stack order: 7
- Branch: `mastra-07-workspace-constraints`
- Pull request base: `mastra-06-session-semantics`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Translate static shared/exclusive workspace constraints into graph edges.
- Retain dynamic admission only for constraints unknowable before execution.
- Remove replaced lock/scheduler paths after callers switch.

## Out of scope

- Tool permission policy.
- Speculative concurrency optimization.

## Implementation plan

1. Separate static from dynamic constraints.
2. Add deterministic edge generation and cycle detection.
3. Delete obsolete admission infrastructure in scope.

## Affected areas

- `libs/seqlane-runtime/src/runtime/workspace/`
- compiler ordering tests

## Verification

- Compatible work overlaps and conflicts do not.
- Synthetic cycles and contradictory policies fail before execution.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

Workspace ordering is expressed through Mastra-compatible execution structure without a competing scheduler.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-session-semantics](./2026-09-03-mastra-session-semantics.md)
