---
id: adr.mastra-local-mechanical-tasks
title: Run Local Mechanical Tasks Through Mastra LocalSandbox
status: accepted
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - adr.local-mechanical-tasks
  - spec.mastra-runtime-and-operational-integration
supersedes:
  - adr.local-mechanical-tasks
---

# Run Local Mechanical Tasks Through Mastra LocalSandbox

## Context

Seqlane supports local mechanical tasks for deterministic work that does not
need an agent or model tokens. The public task and Plan contracts remain
Seqlane-owned and must stay independent of the runtime engine.

The Mastra migration replaced the previous private subprocess implementation
with Mastra's local process primitive. The active local-task specification and
the previous ADR must therefore identify the same runtime owner.

## Decision

Mastra `LocalSandbox` is the authoritative subprocess owner for local task
execution in the Mastra runtime. Each invocation uses direct executable and
argv arguments, the canonical workspace as its current directory, bounded
output, timeout and cancellation support, and normalized Seqlane results.

Seqlane continues to own local task definitions, input and output schemas,
Plan representation, workspace policy, invocation identity, and stable events.
Mastra types and objects remain private to the runtime integration boundary.

The Mastra Plan compiler does not yet dispatch local task definitions through
this path. That work is tracked separately by
`task.mastra-local-task-dispatch`. Repeat support is also a separate future
change.

## Alternatives considered

### Keep Effect as the subprocess owner

This would retain a second process-execution architecture during the Mastra
migration. Rejected because Mastra is the selected generic runtime owner.

### Fall back to Node subprocess APIs

This would bypass the selected runtime integration and create a new lifecycle
boundary. Rejected.

### Dispatch local Plan nodes in this migration slice

This would combine process-primitive migration with compiler integration.
Deferred to the dedicated local-task dispatch task so the boundary remains
independently reviewable.

## Consequences

### Positive

- Mastra owns process lifecycle for the migrated runtime path.
- Local task behavior remains independent of public Mastra contracts.
- Direct argv invocation and bounded results remain explicit.
- Compiler dispatch can be delivered and verified as a separate change.

### Negative

- Local task definitions are not yet executable from Mastra-compiled Plans.
- The migration has a temporary compatibility boundary until dispatch lands.
- Repeat support remains unavailable in this migration slice.

## Traceability

- [adr.local-mechanical-tasks](./2026-09-03-local-mechanical-tasks.md)
- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-deterministic-shell](../tasks/2026-09-03-mastra-deterministic-shell.md)
- [task.mastra-local-task-dispatch](../tasks/2026-09-04-mastra-local-task-dispatch.md)
