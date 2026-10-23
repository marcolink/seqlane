---
id: task.runner-protocol
title: Define a serializable Seqlane runner protocol
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Define a serializable Seqlane runner protocol

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

> Migrated from implementation story `TS-002-01`.

## Use Case

**As a** Seqlane maintainer, **I want to** exchange explicit Seqlane-owned commands and events between the CLI and runner, **so that** process isolation does not leak runtime-engine, OpenCode, or in-memory runtime objects.

## Acceptance Criteria

**Scenario:** _A run request crosses the boundary safely_

- **Given:** The CLI has selected a workflow and has JSON input and OpenCode connection details
- **When:** It creates a runner command
- **Then:** The command contains a serializable workflow reference, input, and connection configuration, and contains no Plan or executable object

**Scenario:** _Runtime outcomes cross the boundary safely_

- **Given:** The runner emits lifecycle events or a normalized failure
- **When:** The protocol encodes the event
- **Then:** The event is JSON-serializable, uses Seqlane-owned shapes, and excludes raw causes and runtime-engine/OpenCode types

## Technical Details

The V1 command set is `run.start` and `run.cancel`. The event set is `run.started`, invocation started/succeeded/failed, and run succeeded/failed/cancelled. A `SerializedSeqlaneError` carries category, message, and optional task identity only.

## Out of Scope

- Node IPC alternatives
- Full RunRecord persistence
- runtime-engine or OpenCode event types in the public protocol
- Interactive request/response messages

## Source and current owners

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [MVP — Seqlane Runner Protocol](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
