---
id: task.studio-static-plan-projection
title: Render Static Plans and Live Invocations in Studio
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.consumer-agnostic-seqlane-execution-events
supersedes: []
---

# Render Static Plans and Live Invocations in Studio

> Migrated from implementation story `TS-016-03`.

## Summary

Show the full graph immediately and overlay actual execution as it happens.

## Use Case

**As a** developer debugging a workflow in Studio, **I want to** see planned
nodes before they run and their live invocation state afterward, **so that** I
can understand both intended topology and actual behavior.

## Acceptance Criteria

**Scenario:** *A Plan prefix renders the full graph*

- **Given:** Studio receives `run.started` followed by `run.plan`
- **When:** No invocation event has arrived yet
- **Then:** The graph shows every planned node, including nested repeat-body
  nodes, as not-yet-instantiated

**Scenario:** *Actual invocations overlay planned nodes*

- **Given:** An invocation references a planned node
- **When:** Its lifecycle events arrive
- **Then:** Studio attaches state using `planNodeId` while preserving the
  invocation's unique `invocationId` and runtime dependency edges

**Scenario:** *A run without a Plan is visibly incomplete*

- **Given:** Studio receives execution events without `run.plan`
- **When:** The run remains observable
- **Then:** Studio marks it incomplete and does not infer a static graph from
  invocation snapshots

## Technical Details

Switch Studio protocol types and ingestion to `SeqlaneExecutionEvent`. Add a
Studio-specific Plan snapshot view model and store it in the registry. Update
the browser projection and graph layout so planned nodes use `planNodeId`,
actual instances use `invocationId`, static edges use `dependsOn`, and runtime
edges use `dependencyIds`. Do not create synthetic invocation IDs for planned
nodes.

Dependencies: task.canonical-execution-events-package through task.cli-consumer-fanout. Likely files:
`libs/seqlane-studio/src/protocol.ts`, registry/service tests,
`apps/seqlane-studio/src/client/projection.ts`, graph layout, and browser
tests. Verify prefix rendering, nested repeats, repeated invocations, and
identity separation.

## Out of Scope

- Browser controls that start, cancel, or resume runs
- Cross-run graph comparison
- Persistent Studio history
- Changes to canonical event ownership

## Source

- [adr.consumer-agnostic-seqlane-execution-events](../adrs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [spec.consumer-agnostic-seqlane-execution-events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [spec.local-read-only-execution-studio](../specs/2026-09-02-local-read-only-execution-studio.md)

## Traceability

- [spec.consumer-agnostic-seqlane-execution-events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
