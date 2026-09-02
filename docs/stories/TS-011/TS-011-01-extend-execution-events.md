# TS-011-01 — Extend Execution Events for Topology and Progress

**Status:** completed

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

- [ADR-011 — Isolate Seqlane Execution Output](../../ADR-011-dedicated-seqlane-output-package.md)
- [TS-011 — Seqlane Execution Output Package](../../TS-011-seqlane-execution-output-package.md)
- [RFC-002 — Seqlane Execution Observability and Debugging](../../RFC-002-execution-observability-and-debugging.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [TS-007 — Work, Run, and Invocation Identity Model](../../TS-007-work-run-invocation-identity-model.md)
