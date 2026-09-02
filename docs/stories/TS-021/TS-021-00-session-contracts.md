# TS-021-00 — Define Session Checkpoint Authoring and Plan Contracts

**Status:** completed

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

- [ADR-021](../../ADR-021-session-checkpoint-reuse-and-branching.md)
- [TS-021](../../TS-021-session-checkpoint-reuse-and-branching.md)
