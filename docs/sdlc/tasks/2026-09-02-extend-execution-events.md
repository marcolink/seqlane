---
id: task.extend-execution-events
title: Extend Execution Events for Topology and Progress
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.seqlane-execution-output-package
supersedes: []
---

# Extend Execution Events for Topology and Progress

> Migrated from implementation story `TS-011-01`.

## Use Case

**As a** human or CI operator, **I want to** see all known steps, nested
workflows, dependency waits, and liveness updates, **so that** parallel or
long-running execution is understandable.

## Scope

- Add runner event metadata: schema version, event ID, sequence, and timestamp.
- Add invocation.created with task/workflow kind, label, parent invocation,
  sibling order, and dependency identities.
- Add invocation.progress for phase, state, redacted activity, and wait reason.
- Add invocation.output with transient versus persistent rendering policy.
- Add invocation.retrying with attempt, delay, next attempt, and last error.
- Add explicit skip, continuation, and dependency-failure reasons.
- Add bounded failure dispositions so renderers know whether work stopped,
  continued, retried, or caused dependent tasks to skip.
- Add run.heartbeat with an injectable runtime interval.
- Update core protocol validators, serializers, and tests.
- Update runtime event emission and the runner event bridge.
- Preserve terminal event semantics and runner exit-status behavior.

## Out of Scope

- Output package renderers.
- Terminal formatting or GitHub Actions formatting.
- Raw executor transcripts, token streaming, or secrets.
- Persistence or external observability storage.
- Workflow authoring or Plan executor concepts.
- Rollback or compensation execution semantics.

## Implementation Notes

Use Seqlane-owned, executor-neutral fields. Dynamic nested invocations emit
invocation.created when discovered. Sequence allocation is runner-owned and
monotonic within one run. Progress events are throttled or coalesced and must
not mirror every executor delta. Output must be bounded and redacted before it
crosses the runner boundary.

Keep parent invocation identity for containment separate from dependency
identities. Update all in-process Seqlane events and serialized RunnerEvents
consistently.

## Acceptance Criteria

**Scenario:** Event metadata round-trips
- **Given:** A valid event with metadata
- **When:** It is encoded and decoded through the runner protocol
- **Then:** Metadata and event-specific fields are preserved exactly

**Scenario:** Nested topology is serialized
- **Given:** A workflow invocation with two child invocations
- **When:** The runner emits invocation.created events
- **Then:** Each child includes the parent invocation ID, stable sibling order, and dependencies

**Scenario:** Parallel waits are explainable
- **Given:** An invocation waiting on two sibling dependencies
- **When:** The runner emits progress
- **Then:** The event includes a waiting reason and both dependency IDs

**Scenario:** Retry state is explainable
- **Given:** An invocation that will retry after a failure
- **When:** The runner emits invocation.retrying
- **Then:** The event includes attempt, delay or next-attempt time, and last error

**Scenario:** Output policy is explicit
- **Given:** An invocation emits current activity and a final diagnostic
- **When:** The runner emits output events
- **Then:** The events distinguish transient activity from persistent output

**Scenario:** Skip and continuation reasons are preserved
- **Given:** A task is skipped because a dependency failed or continues after a recoverable error
- **When:** The runner emits its terminal or progress event
- **Then:** The reason is available without renderer inference

**Scenario:** Failure disposition is explicit
- **Given:** A task failure under a configured execution policy
- **When:** The runner emits the failure or retry event
- **Then:** The event identifies whether execution stops, continues, retries, or skips dependents

**Scenario:** Long work remains observable
- **Given:** Active work with no durable state transition
- **When:** The heartbeat interval elapses
- **Then:** A heartbeat event is emitted through the same runner event bridge

**Scenario:** Terminal results remain authoritative
- **Given:** A run that succeeds, fails, or is cancelled
- **When:** Progress and heartbeat events have also been emitted
- **Then:** The existing terminal event and exit status remain unchanged

## Source

- [adr.dedicated-seqlane-output-package — Isolate Seqlane Execution Output](../adrs/2026-09-02-dedicated-seqlane-output-package.md)
- [spec.seqlane-execution-output-package — Seqlane Execution Output Package](../specs/2026-09-02-seqlane-execution-output-package.md)
- [rfc.execution-observability-and-debugging — Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)
- [spec.work-run-invocation-identity-model — Work, Run, and Invocation Identity Model](../specs/2026-09-02-work-run-invocation-identity-model.md)

## Traceability

- [spec.seqlane-execution-output-package](../specs/2026-09-02-seqlane-execution-output-package.md)
