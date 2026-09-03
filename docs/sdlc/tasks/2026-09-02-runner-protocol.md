---
id: task.runner-protocol
title: Define a serializable Seqlane runner protocol
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Define a serializable Seqlane runner protocol

> Migrated from implementation story `TS-002-01`.

## Use Case
**As a** Seqlane maintainer, **I want to** exchange explicit Seqlane-owned commands and events between the CLI and runner, **so that** process isolation does not leak Mastra, OpenCode, or in-memory runtime objects.

## Acceptance Criteria
**Scenario:** *A run request crosses the boundary safely*
- **Given:** The CLI has selected a workflow and has JSON input and OpenCode connection details
- **When:** It creates a runner command
- **Then:** The command contains a serializable workflow reference, input, and connection configuration, and contains no Plan or executable object

**Scenario:** *Runtime outcomes cross the boundary safely*
- **Given:** The runner emits lifecycle events or a normalized failure
- **When:** The protocol encodes the event
- **Then:** The event is JSON-serializable, uses Seqlane-owned shapes, and excludes raw causes and Mastra/OpenCode types

## Technical Details
The V1 command set is `run.start` and `run.cancel`. The event set is `run.started`, invocation started/succeeded/failed, and run succeeded/failed/cancelled. A `SerializedSeqlaneError` carries category, message, and optional task identity only.

## Out of Scope
- Node IPC alternatives
- Full RunRecord persistence
- Mastra or OpenCode event types in the public protocol
- Interactive request/response messages

## Source
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [MVP — Seqlane Runner Protocol](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
