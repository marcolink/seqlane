---
id: task.build-read-only-studio-browser-view
title: Build the Read-Only Studio Browser View
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.local-read-only-execution-studio
supersedes: []
---

# Build the Read-Only Studio Browser View

> Migrated from implementation story `TS-013-04`.

## Use Case

**As a** Seqlane user, **I want** to select a live run and inspect its graph,
**so that** I can understand its state, dependencies, inputs, and results.

## Scope

- Show a live run list from snapshots and SSE updates.
- Show a selected run as a non-editable invocation graph.
- Show a selected-node inspector and event timeline.
- Show display values and their present, redacted, truncated, or omitted state.
- Provide a keyboard-accessible invocation list linked to the graph and inspector.
- Handle snapshot refresh after `stream.reset` and incomplete event data.
- Use React local state and `EventSource`; add no global-state or server-state library.
- Use `@xyflow/react` only with editing interactions disabled.

## Out of Scope

- Editing, graph connections, node movement, run control, and workflow authoring.
- Mobile-specific layout, historical comparison, and browser persistence.
- Remote browser access and cross-user collaboration.

## Implementation Notes

Keep node placement, viewport, zoom, and selection stable for state-only
updates. A topology update can add nodes and edges. Use a local deterministic
layered layout. Do not add a layout-library dependency in V1.

The graph never shows raw input or result values in a node label. The inspector
formats JSON and separates structured results from execution output text.

## Acceptance Criteria

**Scenario:** *The browser lists concurrent live runs*

- **Given:** Studio has two active run summaries
- **When:** A browser receives the snapshot and SSE updates
- **Then:** The user can select either run without polling

**Scenario:** *The graph follows actual invocation topology*

- **Given:** A run with dependency edges and repeated Plan-node invocations
- **When:** The browser reduces its events
- **Then:** Each invocation has one node and each edge uses invocation IDs

**Scenario:** *The graph is not editable*

- **Given:** A user views an invocation graph
- **When:** The user drags a node or attempts to create an edge
- **Then:** The graph does not change

**Scenario:** *An inspector shows a protected value safely*

- **Given:** A selected invocation with a redacted input event
- **When:** The user opens the input section
- **Then:** The browser labels it redacted and shows no raw value

**Scenario:** *Keyboard selection reaches the inspector*

- **Given:** A keyboard user in the invocation list
- **When:** The user selects an invocation
- **Then:** The inspector and graph focus update to that invocation

## Source

- [adr.local-read-only-execution-studio — Local Read-Only Execution Studio](../adrs/2026-09-02-local-read-only-execution-studio.md)
- [spec.local-read-only-execution-studio — Local Read-Only Execution Studio](../specs/2026-09-02-local-read-only-execution-studio.md)
- [adr.dedicated-seqlane-output-package — Execution Output Package](../adrs/2026-09-02-dedicated-seqlane-output-package.md)

## Traceability

- [spec.local-read-only-execution-studio](../specs/2026-09-02-local-read-only-execution-studio.md)
