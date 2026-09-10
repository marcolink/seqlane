---
id: task.mastra-identity-events
title: Preserve Identity and Normalized Execution Events
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Preserve Identity and Normalized Execution Events

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-workspace-constraints](./2026-09-03-mastra-workspace-constraints.md)

## Delivery

- Stack order: 8
- Branch: `mastra-08-identity-events`
- Pull request base: `mastra-07-workspace-constraints`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Propagate Work, Run, and Invocation metadata through Mastra.
- Map Mastra lifecycle data to the stable Seqlane event/result contract.
- Preserve cancellation and typed error categories with original causes.

## Out of scope

- A second trace or run-state store.
- Changes to consumer-agnostic serialized event ownership.

## Implementation plan

1. Define the private correlation mapping.
2. Switch runner and CLI event sources.
3. Remove replaced lifecycle translation paths.

## Affected areas

- `libs/seqlane-events/`
- `libs/seqlane-runtime/src/runner/`
- `libs/seqlane-output/`

## Verification

- Correlation and event ordering tests pass.
- Serialized contracts contain no Mastra types.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

CLI and external consumers observe stable Seqlane events backed by Mastra execution.

## Outcome

The runner now compiles and starts Seqlane Plans as private Mastra workflows.
Work IDs are carried as Mastra resource identities, Run IDs are supplied to
Mastra workflow runs, and each compiled step carries its stable Invocation ID.
The runner maps Mastra success, failure, and cancellation results to the stable
Seqlane run contract while the existing invocation event bridge preserves
ordered, serialized Seqlane events and original typed error causes.

Focused compiler, runtime, cancellation, and runner tests pass. The bridge
keeps Mastra types private and does not add a second serialized event owner or
run-state store.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-workspace-constraints](./2026-09-03-mastra-workspace-constraints.md)
