---
id: task.extend-runner-events-for-graph-and-values
title: Extend Runner Events for Graph Topology and Values
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.local-read-only-execution-studio
supersedes: []
---

# Extend Runner Events for Graph Topology and Values

> Migrated from implementation story `TS-013-01`.

## Use Case

**As a** Studio user, **I want** each invocation to identify its Plan source
and safe input/result data, **so that** I can inspect the actual run graph.

## Scope

- Add `planNodeId` to `invocation.created` in core runner contracts.
- Add `SeqlaneDisplayValue`, `invocation.input`, and `invocation.result`.
- Extend protocol guards, encoders, decoders, and contract fixtures.
- Emit the new events from the private runtime after value policy processing.
- Define and implement the Seqlane-owned display-value policy boundary.
- Add generic task observability metadata for safe JSON Pointer path selection.
- Update output-package event consumers for exhaustive event handling.

## Out of Scope

- Studio HTTP transport, CLI forwarding, and browser rendering.
- Executor transcript, prompt, tool-call, or session events.
- Durable result storage and a public executor configuration surface.

## Implementation Notes

The runtime maps each Plan-node address to a runtime invocation before it emits
topology. It emits a result event only after output validation succeeds.

The default display policy omits unknown raw values. Redacted variants must not
contain raw JSON. The policy must stay executor-neutral and use field-level
path selection. A selected value must satisfy the spec.local-read-only-execution-studio size and depth limits.

## Acceptance Criteria

**Scenario:** *Topology identifies a Plan node*

- **Given:** A compiled Plan node with a runtime invocation
- **When:** The runtime emits `invocation.created`
- **Then:** The event includes the correct `planNodeId` and `invocationId`

**Scenario:** *A safe input and result are inspectable*

- **Given:** A policy that permits bounded input and output values
- **When:** The task completes successfully
- **Then:** Input precedes result and result precedes `invocation.succeeded`

**Scenario:** *A protected value does not leak*

- **Given:** A value denied by the display policy
- **When:** The runtime emits its display event
- **Then:** The event is redacted or omitted and has no raw JSON value

## Source

- [adr.local-read-only-execution-studio — Local Read-Only Execution Studio](../adrs/2026-09-02-local-read-only-execution-studio.md)
- [spec.local-read-only-execution-studio — Local Read-Only Execution Studio](../specs/2026-09-02-local-read-only-execution-studio.md)
- [spec.work-run-invocation-identity-model — Work, Run, and Invocation Identity](../specs/2026-09-02-work-run-invocation-identity-model.md)
- [spec.seqlane-execution-output-package — Seqlane Execution Output Package](../specs/2026-09-02-seqlane-execution-output-package.md)

## Traceability

- [spec.local-read-only-execution-studio](../specs/2026-09-02-local-read-only-execution-studio.md)
