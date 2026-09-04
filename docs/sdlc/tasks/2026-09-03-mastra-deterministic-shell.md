---
id: task.mastra-deterministic-shell
title: Run Deterministic Shell Tasks Through Mastra
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-04
upstream:
  - spec.mastra-runtime-and-operational-integration
  - spec.local-mechanical-tasks
supersedes: []
---

# Run Deterministic Shell Tasks Through Mastra

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-plan-compiler](./2026-09-03-mastra-plan-compiler.md)

## Delivery

- Stack order: 4
- Branch: `mastra-04-deterministic-shell`
- Pull request base: `mastra-03-plan-compiler`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Map deterministic tasks to Mastra Workspace or Sandbox processes.
- Normalize output, timing, timeout, cancellation, and identity.
- Switch callers and delete the replaced Effect subprocess path.

## Out of scope

- Agent execution.
- General shell-string parsing unless explicitly required by the public contract.
- Dispatch local task definitions from Mastra-compiled Plans.
- Repeat support.

## Implementation plan

1. Verify the pinned process API.
2. Implement argv-first process execution.
3. Add zero-model-call tests and remove obsolete code/dependencies.

## Affected areas

- `libs/seqlane-runtime/src/runtime/local/`
- local task contracts and tests

## Verification

- Success, non-zero exit, timeout, cancellation, and output bounds are covered.
- Tests prove zero agent/model invocations.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

Deterministic tasks use Mastra process primitives exclusively.

## Outcome

Deterministic local task invocations now use the pinned Mastra `LocalSandbox`
process path with direct command arguments. Results normalize exit status,
bounded output, timing, timeout, cancellation, task identity, and invocation
identity. The replaced Effect subprocess implementation, prototype, tests, and
direct platform dependencies were removed. The public workflow and task
contracts remain free of Mastra types.

The Mastra Plan compiler does not yet dispatch local task definitions through
this process path. That integration is tracked in
`task.mastra-local-task-dispatch`. Repeat support remains a separate future
change.

Focused runtime tests, runtime typecheck, runtime lint, test mapping, and the
lockfile-only dependency synchronization passed. The repository-wide gates
remain for the stacked migration validation.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [task.mastra-plan-compiler](./2026-09-03-mastra-plan-compiler.md)
- [task.mastra-local-task-dispatch](./2026-09-04-mastra-local-task-dispatch.md)
