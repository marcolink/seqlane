---
id: task.local-task-contracts
title: Define Local Task Contracts
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.local-mechanical-tasks
supersedes: []
---

# Define Local Task Contracts

## Objective

As a workflow author, I can define a deterministic local task with the same
`defineTask()` and `.task()` APIs that I use for agent tasks.

## Upstream requirements

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [task.effect-v3-subprocess-gate](2026-09-03-effect-v3-subprocess-gate.md)

## Scope

- Discriminated `goal` and `execute` task definitions in `@seqlane/core`.
- A minimal public `TaskContext` with `exec`.
- Typed Flow overloads and output-only local task handles.
- Runtime loading validation for mixed or missing task behavior.

## Out of scope

- Plan serialization, subprocess execution, Git helpers, and agent behavior
  changes.

## Implementation plan

1. Add the public local-task contracts without Effect or Node types.
2. Preserve agent-task overloads and add output-only local handles.
3. Validate the task discriminant at runtime and in compile-time coverage.

## Affected areas

- `libs/seqlane-core/`

## Verification

- Core contract and builder tests cover local and agent task definitions.
- Runtime loading rejects mixed and missing task behavior.
- Repository test mapping and lint/type checks pass.

## Completion criteria

Local definitions compose through `.task()`, expose no session checkpoint, and
cannot mix `goal` and `execute` behavior.

## Outcome

The public contracts, overloads, output-only local handles, and runtime
definition checks were implemented and covered in [PR #8](https://github.com/marcolink/seqlane/pull/8).

## Traceability

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [adr.local-mechanical-tasks](../adrs/2026-09-03-local-mechanical-tasks.md)
- [task.effect-v3-subprocess-gate](2026-09-03-effect-v3-subprocess-gate.md)
- [PR #8](https://github.com/marcolink/seqlane/pull/8)
