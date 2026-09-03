---
id: task.mastra-community-dependencies
title: Add Community Mastra Dependencies and Boundary Guards
status: planned
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Add Community Mastra Dependencies and Boundary Guards

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-migration-foundation](./2026-09-03-mastra-migration-foundation.md)

## Delivery

- Stack order: 1
- Branch: `mastra-01-community-dependencies`
- Pull request base: `mastra`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Verify and pin the minimum Community Mastra packages.
- Synchronize `pnpm-lock.yaml`.
- Add public-import and forbidden `/ee/` architecture guards.

## Out of scope

- Workflow compilation or task execution.
- Removing Effect runtime code.

## Implementation plan

1. Inspect installed package exports and licenses.
2. Add the minimum dependencies at the private integration boundary.
3. Add executable boundary and license checks.

## Affected areas

- `libs/seqlane-runtime/package.json`
- `pnpm-lock.yaml`
- runtime boundary tests

## Verification

- Pinned imports typecheck.
- Core/public packages remain Mastra-free.
- The `/ee/` guard fails on a forbidden fixture.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

Community Mastra dependencies and enforceable boundary guards are available without changing runtime behavior.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-migration-foundation](./2026-09-03-mastra-migration-foundation.md)
