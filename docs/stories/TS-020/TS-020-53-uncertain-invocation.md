# TS-020-53 — Retain Uncertain Invocations as Active

**Status:** completed

## User outcome

As a workflow author, a timed-out or disconnected task remains potentially
active until termination is confirmed.

## Scope

- Model timeout and disconnect as uncertain activity.
- Retain session and workspace locks until confirmation or quarantine.

## Out of scope

- Remote Run recovery after process restart.

## Implementation notes

Use the same state as unconfirmed cancellation. Do not mark an uncertain task
as complete or release resources from timeout alone.

## Acceptance criteria

**Scenario:** *An executor disconnects during exclusive work*

- **Given:** An exclusive invocation with no termination confirmation
- **When:** The runtime handles the disconnect
- **Then:** A competing invocation cannot receive its locks

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
