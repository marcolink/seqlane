---
id: task.map-exit-status
title: Map terminal outcomes and unexpected runner exits to CLI status
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.dedicated-runner-process
supersedes: []
---

# Map terminal outcomes and unexpected runner exits to CLI status

> Migrated from implementation story `TS-002-04`.

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
- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [adr.dedicated-runner-process — Execute Each Seqlane Run in a Dedicated Node Process](../adrs/2026-09-02-dedicated-runner-process.md)

## Traceability

- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)
