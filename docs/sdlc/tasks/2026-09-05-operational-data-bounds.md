---
id: task.operational-data-bounds
title: Bound Operational Data Retention and Queries
status: planned
owners:
  - core
created: 2026-09-05
updated: 2026-09-05
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Bound Operational Data Retention and Queries

## Objective

Keep local durable operational data finite and its read paths bounded.

## Dependencies

- [task.workflow-discovery-and-plan-cli](./2026-09-04-workflow-discovery-and-plan-cli.md)

## Delivery

- Stack order: 15
- Branch: `mastra-15-operational-data-bounds`
- Pull request base: `mastra-14-workflow-discovery-plan`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-operational-data-bounds`
- `requirement-storage-tracing`
- `requirement-public-boundary`

## Scope

- Define one validated retention and query-limits configuration.
- Bound retained completed runs, traces, and storage records by the configured
  policy.
- Define cleanup ordering that never removes state required by an active run.
- Add validated pagination or continuations and maximum result sizes for
  operational read paths.
- Produce stable typed failures for invalid limits and invalid continuations.

## Out of scope

- Remote storage, multi-user data isolation, or hosted retention policies.
- A second Seqlane run, trace, or storage store.
- Changing normalized Seqlane event contracts.

## Implementation plan

1. Define retention and query-limit schemas with bounded defaults.
2. Implement cleanup that preserves active-run state.
3. Add paginated, bounded operational queries.
4. Test long-lived data, active runs, invalid cursors, and result limits.

## Affected areas

- private Mastra storage and tracing integration
- operational server query adapters
- runtime contract tests
- local operation documentation

## Verification

- Cleanup never removes an active run's required state.
- Completed data obeys configured retention limits.
- Each operational read has a maximum result size and continuation behavior.
- Invalid limits and continuations fail before storage access.

## Completion criteria

The local operational host can retain and query canonical Mastra data without
unbounded storage growth or unbounded response projections.

## Outcome

Not started.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [adr.local-mastra-operational-host](../adrs/2026-09-05-local-mastra-operational-host.md)
