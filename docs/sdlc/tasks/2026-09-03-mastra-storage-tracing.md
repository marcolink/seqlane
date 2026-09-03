---
id: task.mastra-storage-tracing
title: Use Mastra Storage and Tracing as the Operational Source
status: planned
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Use Mastra Storage and Tracing as the Operational Source

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-identity-events](./2026-09-03-mastra-identity-events.md)

## Delivery

- Stack order: 9
- Branch: `mastra-09-storage-tracing`
- Pull request base: `mastra-08-identity-events`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Configure Mastra storage and tracing for Seqlane runs.
- Attach Seqlane correlation metadata.
- Delete parallel canonical run/trace state in scope.

## Out of scope

- Server, MCP, and Studio presentation.
- Hosted Mastra services.

## Implementation plan

1. Verify Community storage/tracing APIs.
2. Integrate local configuration and fixtures.
3. Switch readers and remove dual writes.

## Affected areas

- runtime configuration
- run-state and observability modules
- integration fixtures

## Verification

- Runs and steps are inspectable with Seqlane identities.
- No complete Seqlane mirror or dual write remains.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

Mastra is canonical for operational state and traces.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-identity-events](./2026-09-03-mastra-identity-events.md)
