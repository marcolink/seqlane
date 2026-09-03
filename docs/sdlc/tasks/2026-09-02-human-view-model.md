---
id: task.human-view-model
title: Build the Nested and Parallel Human View Model
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.seqlane-execution-output-package
supersedes: []
---

# Build the Nested and Parallel Human View Model

> Migrated from implementation story `TS-011-02`.

## Use Case

**As a** local operator, **I want to** see nested workflows and parallel tasks
as stable rows, **so that** I can understand current execution without reading
raw event logs.

## Scope

- Implement the pure event-to-human-view-model reducer.
- Maintain a normalized invocation map and root invocation order.
- Track containment separately from dependencies.
- Derive visible rows, indentation, aggregate counts, waiting reasons, elapsed
  time, and renderer-local expansion/focus state.
- Track transient activity, persistent output, retry countdowns, failure
  summaries, skip reasons, and continuation policy.
- Apply safe label updates without changing invocation identity or row order.
- Handle queued, waiting, running, retrying, succeeded, failed, skipped, and
  cancelled states.
- Add deterministic event-sequence fixtures for nested and parallel execution.

## Out of Scope

- ANSI or terminal cursor handling.
- CI output and JSON serialization.
- Runner event production.
- Keyboard navigation or persistent run inspection.

## Implementation Notes

Use stable sibling order and event sequence only as a tie-breaker. Do not reorder
rows when parallel events arrive. A collapsed workflow hides descendants but
retains an aggregate summary. Dependency edges must never be rendered as
containment parents.

The reducer must use an injected clock or event timestamps for deterministic
elapsed-time tests. Renderer presentation state is local and must not be added
to canonical events.

## Acceptance Criteria

**Scenario:** All known steps appear before execution
- **Given:** invocation.created events for a workflow and its children
- **When:** The view model is reduced
- **Then:** Every known invocation has a stable row before invocation.started

**Scenario:** Nested workflows render as containment
- **Given:** A workflow containing a nested workflow containing two tasks
- **When:** The view model is expanded
- **Then:** Rows have the correct depth and parent relationship

**Scenario:** Parallel siblings remain independent
- **Given:** Two sibling tasks started in an interleaved event order
- **When:** The view model is reduced
- **Then:** Both rows remain visible, independently active, and in stable sibling order

**Scenario:** Dependency waiting is visible
- **Given:** A task waiting on two dependencies
- **When:** Its progress event is reduced
- **Then:** The row exposes the waiting reason and dependency labels

**Scenario:** Completion collapses correctly
- **Given:** A nested workflow whose descendants all completed
- **When:** Terminal events are reduced
- **Then:** The workflow can render as one aggregate row with completed counts

**Scenario:** Failure remains diagnosable
- **Given:** A failed nested task
- **When:** Its failure event is reduced
- **Then:** The row exposes a concise redacted failure message without changing sibling state

**Scenario:** Retry state remains visible
- **Given:** An invocation retrying after a failed attempt
- **When:** Its retry event is reduced
- **Then:** The row exposes the attempt, next-attempt time, and last error

**Scenario:** Output persistence is respected
- **Given:** Transient activity and persistent output events for one invocation
- **When:** The view model is reduced through task completion
- **Then:** Transient activity may be replaced while persistent output remains available

**Scenario:** Skip and continuation policy is visible
- **Given:** A task skipped by dependency failure or continued after a recoverable error
- **When:** The relevant event is reduced
- **Then:** The row exposes the reason and does not mislabel the task as an execution failure

**Scenario:** Failure disposition is rendered accurately
- **Given:** A failure event with a continue, retry, or skip-dependent disposition
- **When:** The view model is reduced
- **Then:** The row and aggregate state reflect the disposition without inferring fail-fast behavior

## Source

- [adr.dedicated-seqlane-output-package — Isolate Seqlane Execution Output](../adrs/2026-09-02-dedicated-seqlane-output-package.md)
- [spec.seqlane-execution-output-package — Seqlane Execution Output Package](../specs/2026-09-02-seqlane-execution-output-package.md)
- [rfc.execution-observability-and-debugging — Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [adr.work-run-invocation-identity-model — Distinguish Work, Run, and Invocation Identity](../adrs/2026-09-02-work-run-invocation-identity-model.md)

## Traceability

- [spec.seqlane-execution-output-package](../specs/2026-09-02-seqlane-execution-output-package.md)
