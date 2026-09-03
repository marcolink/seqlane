---
id: task.session-contracts
title: Define Session Checkpoint Authoring and Plan Contracts
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.session-checkpoint-reuse-and-branching
supersedes: []
---

# Define Session Checkpoint Authoring and Plan Contracts

> Migrated from implementation story `TS-021-00`.

## User outcome

As a workflow author, I can explicitly choose isolated, reuse, or branch agent
sessions with typed task handles.

## Scope

- Add opaque `SessionCheckpointRef`, helpers, typed agent invocation handles,
  and serializable task-node session policy.
- Make omitted policy serialize as `isolated`.
- Keep mechanical task/validator handles without `.session`.
- Add core public/Plan compatibility tests.

## Out of scope

Runtime resolution, graph validation beyond basic Plan schema, and executor
forking.

## Implementation notes

Keep checkpoint references executor-neutral and free of runtime IDs. Extend the
existing DSL and repeat types only where a task is agent-backed.

## Acceptance criteria

**Scenario:** *Default task session*

- **Given:** A task without a session option
- **When:** Its Plan is built
- **Then:** its node has `isolated` session policy

**Scenario:** *Mechanical handle*

- **Given:** a shell/mechanical task handle
- **When:** TypeScript checks workflow authoring
- **Then:** it cannot be a session checkpoint source

## Source

- [adr.session-checkpoint-reuse-and-branching](../adrs/2026-09-02-session-checkpoint-reuse-and-branching.md)
- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)

## Traceability

- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)
