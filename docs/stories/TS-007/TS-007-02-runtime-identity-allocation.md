# TS-007-02 — Preserve execution identity through runner and CLI

**Status:** completed

## User Outcome

**As a** workflow operator, **I want** the runner and CLI to preserve generated execution identities, **so that** the process boundary does not break correlation.

## Scope

- Update the event bridge to serialize all identity fields unchanged.
- Update runner-client supervision and CLI projection types/tests for identity-bearing events.
- Verify child-process delivery for normal, load/validation failure, task failure, and cancellation outcomes.
- Keep CLI presentation concise without allocating, recomputing, or using Task ID as a correlation key.

## Out of Scope

- Runtime ID allocation or Plan-node mapping.
- Work persistence, continuation, lookup, or selection.
- Nested workflow, retry-attempt, session, checkpoint, or artifact identity.
- Git trailers or commit-SHA collection.

## Implementation Notes

The event bridge performs no identity generation or translation. It only converts Seqlane errors/output into process-safe forms while retaining the generated fields. CLI supervision decodes validated events and gives its projection the original event object. The CLI must not introduce a `--work` option or any user-selected execution identity.

## Acceptance Criteria

**Scenario:** *The process boundary preserves a Work/Run pair*
- **Given:** the private runtime emits a lifecycle event with generated execution identity
- **When:** the runner bridge and client transport it
- **Then:** the CLI receives the same Work ID, Run ID, and, when present, Invocation ID

**Scenario:** *Terminal outcomes retain correlation*
- **Given:** execution completes, fails during loading, fails in an invocation, or is cancelled
- **When:** the runner reports its terminal event to the CLI
- **Then:** it retains the initiating Work/Run pair, and an invocation failure retains its Invocation ID

**Scenario:** *CLI presentation does not create identity*
- **Given:** a validated runner event
- **When:** the CLI projects it for display
- **Then:** the projection retains the original structured event and does not infer an ID from the Task or Plan node

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-007 — Distinguish Work, Run, and Invocation Identity](../../ADR-007-work-run-invocation-identity-model.md)
- [TS-007 — Work, Run, and Invocation Identity Model](../../TS-007-work-run-invocation-identity-model.md)
- [TS-002 — Dedicated Runner Process and CLI IPC](../../TS-002-dedicated-runner-process.md)
- [TS-008 — Executor-Neutral Workflow Authoring](../../TS-008-executor-neutral-workflow-authoring.md)
