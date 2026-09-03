# TS-023-02 — Serialize and Validate Local Task Nodes

**Status:** completed
**Depends on:** TS-023-01

## User outcome

As a workflow author, I can compose local tasks through typed dataflow without
putting executable callbacks or runtime state into a Plan.

## Scope

- Task execution discriminator in core Plan types and builder lowering.
- Local task definition registry and repeat-body support.
- Plan validation, snapshot projection, and malformed-input coverage.
- Compatibility behavior for legacy task nodes without an execution discriminator.

## Out of scope

- Effect subprocess implementation and agent executor changes.

## Acceptance criteria

**Scenario:** *Build a local task Plan node*

- **Given:** a flow with a local task
- **When:** Seqlane builds its Plan
- **Then:** the node identifies local execution and contains no callback or process data

**Scenario:** *Reject an invalid local Plan node*

- **Given:** a Plan with a local task session declaration or wrong definition kind
- **When:** runtime Plan validation runs
- **Then:** it rejects the Plan before execution

**Scenario:** *Preserve old agent Plans*

- **Given:** a legacy Plan task node without an execution discriminator
- **When:** runtime Plan validation runs
- **Then:** it resolves as an agent task

## Source

- [ADR-023](../../ADR-023-local-mechanical-tasks.md)
- [TS-023](../../TS-023-local-mechanical-tasks.md)
