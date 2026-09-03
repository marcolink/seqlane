---
id: task.mastra-runtime-spine
title: Create the Mastra Runtime Spine
status: planned
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Create the Mastra Runtime Spine

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-community-dependencies](./2026-09-03-mastra-community-dependencies.md)

## Delivery

- Stack order: 2
- Branch: `mastra-02-runtime-spine`
- Pull request base: `mastra-01-community-dependencies`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Create the private Mastra registration and run boundary.
- Execute one minimal fixture workflow through Mastra.
- Normalize one success and one failure outcome.

## Out of scope

- Full Plan compilation.
- Agent, shell, session, workspace, server, MCP, or Studio migration.

## Implementation plan

1. Verify the pinned workflow API.
2. Add the narrow integration modules.
3. Prove a smoke workflow without exposing Mastra types.

## Affected areas

- `libs/seqlane-runtime/src/runtime/mastra/`
- runtime integration tests

## Verification

- The smoke workflow succeeds and fails deterministically.
- Public declarations contain no Mastra types.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

A minimal Mastra workflow runs behind a private Seqlane boundary.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-community-dependencies](./2026-09-03-mastra-community-dependencies.md)
