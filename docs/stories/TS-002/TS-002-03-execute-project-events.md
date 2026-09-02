# TS-002-03 — Execute the workflow and project structured events through the CLI

**Status:** completed


## Use Case
**As a** workflow operator, **I want to** see Seqlane lifecycle progress while the child executes the workflow, **so that** CLI output reflects authoritative structured runtime state.

## Acceptance Criteria
**Scenario:** *Successful execution is projected to the terminal*
- **Given:** The runner has loaded a valid workflow and the TS-001 runtime can execute it
- **When:** The workflow runs through the child boundary
- **Then:** Invocation and run events are forwarded over IPC, rendered by the CLI, and the final Seqlane output is returned without exposing Mastra types

**Scenario:** *Failure stops the projected run*
- **Given:** An invocation fails inside the runner
- **When:** The runtime reports the failure
- **Then:** The CLI receives the invocation and run failure events, does not render downstream work as successful, and preserves the normalized Seqlane error

## Technical Details
The runner maps in-process runtime events to `RunnerEvent`. The CLI renders events and does not parse runner logs or executor transcripts to infer status.

## Out of Scope
- Persistent event storage
- A local visual inspector
- Full OpenCode traces, OTEL, or Mastra Studio
- Parallel or interactive workflow execution

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [TS-001 — Mastra Runtime Integration](../../TS-001-mastra-runtime-integration.md)
