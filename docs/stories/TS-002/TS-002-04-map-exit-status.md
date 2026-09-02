# TS-002-04 — Map terminal outcomes and unexpected runner exits to CLI status

**Status:** completed


## Use Case
**As a** workflow operator, **I want to** receive a reliable command result, **so that** scripts and humans can distinguish success, failure, cancellation, and runner failure.

## Acceptance Criteria
**Scenario:** *Terminal outcomes produce deterministic exit statuses*
- **Given:** The CLI receives one terminal runner event
- **When:** The child exits
- **Then:** `run.succeeded` maps to exit `0`, `run.failed` maps to exit `1`, and `run.cancelled` maps to exit `130`

**Scenario:** *Unexpected process termination is not success*
- **Given:** The child exits without a terminal event
- **When:** The CLI completes supervision
- **Then:** The CLI reports a runner/process failure and exits non-zero even if the child exit code is zero

## Technical Details
The terminal event is authoritative. The child must emit exactly one terminal event and exit; duplicate starts, unknown commands, malformed messages, and invalid event payloads are protocol failures.

## Out of Scope
- Shell-specific exit-code customization
- Resuming a process after a crash
- Durable recovery or replay

## Source
- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [ADR-002 — Execute Each Seqlane Run in a Dedicated Node Process](../../ADR-002-dedicated-runner-process.md)
