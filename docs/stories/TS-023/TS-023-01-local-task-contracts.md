# TS-023-01 — Define Local Task Contracts

**Status:** completed
**Depends on:** TS-023-00 passes

## User outcome

As a workflow author, I can define a deterministic local task with the same
`defineTask()` and `.task()` APIs that I use for agent tasks.

## Scope

- Discriminated `goal` and `execute` task definitions in `@seqlane/core`.
- A minimal public `TaskContext` with `exec`.
- Typed Flow overloads and output-only local task handles.
- Runtime loading validation for mixed or missing task behavior.

## Out of scope

- Plan serialization, subprocess execution, Git helpers, and agent behavior changes.

## Acceptance criteria

**Scenario:** *Author a local task*

- **Given:** a task definition with input/output schemas and `execute`
- **When:** it is added through `.task()`
- **Then:** the flow receives a typed output handle without `session`

**Scenario:** *Author an agent task*

- **Given:** a task definition with `goal`
- **When:** it is added through `.task()`
- **Then:** the flow receives its existing agent session handle

**Scenario:** *Reject mixed task behavior*

- **Given:** a definition with both `goal` and `execute`
- **When:** TypeScript or runtime validation evaluates it
- **Then:** the definition is rejected

## Source

- [ADR-023](../../ADR-023-local-mechanical-tasks.md)
- [TS-023](../../TS-023-local-mechanical-tasks.md)
