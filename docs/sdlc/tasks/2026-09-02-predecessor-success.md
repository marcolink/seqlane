---
id: task.predecessor-success
title: Gate Dependent Invocations on Predecessor Success
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Gate Dependent Invocations on Predecessor Success

> Migrated from implementation story `TS-020-02`.

## User outcome

As a workflow author, a dependent task does not start after its predecessor
fails.

## Scope

- Stop ordered execution at the first task error.
- Prove that a dependent executor does not run after predecessor failure.

## Out of scope

- Retry and concurrent scheduling.

## Implementation notes

The current runner stops the sequential program after a failed node. The test
asserts that the dependent executor has no call.

## Acceptance criteria

**Scenario:** *A predecessor fails*

- **Given:** A node that fails and a dependent node
- **When:** The runtime starts the Plan
- **Then:** The dependent node does not execute

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
