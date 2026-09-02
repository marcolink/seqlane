# TS-016-03 — Render Static Plans and Live Invocations in Studio

**Status:** completed

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

Dependencies: TS-016-00 through TS-016-02. Likely files:
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

- [ADR-016](../../ADR-016-consumer-agnostic-seqlane-execution-events.md)
- [TS-016](../../TS-016-consumer-agnostic-seqlane-execution-events.md)
- [TS-013](../../TS-013-local-read-only-execution-studio.md)
