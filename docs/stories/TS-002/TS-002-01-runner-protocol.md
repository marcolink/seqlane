# TS-002-01 — Define a serializable Seqlane runner protocol

**Status:** completed


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
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [MVP — Seqlane Runner Protocol](../../MVP.md)
