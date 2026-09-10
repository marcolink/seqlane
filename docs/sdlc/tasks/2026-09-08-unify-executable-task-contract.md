---
id: task.unify-executable-task-contract
title: Unify the Executable Task Contract
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-09
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Unify the Executable Task Contract

## Objective

Make `defineTask` the one foundational executable task contract. Make the
specialized agent and shell factories construct that contract.

## Upstream requirements

- `REQ-TASK-001`: Use one executable task contract.
- `REQ-PLAN-002`: Validate Plan data at runtime.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

None. This is the first implementation slice.

## Delivery

- Stack order: 1
- Branch: `mastra-01-unify-executable-task-contract`
- Pull request base: `mastra`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Define one shared task shape with Zod input and output schemas and a
  runtime-owned `TaskContext`.
- Require `execute` in `defineTask`.
- Make `defineAgentTask` and `defineShellTask` provide `execute`.
- Define `defineShellTask` with an executable-plus-argv request shape and the
  canonical `{ exitCode, stdout, stderr }` result schema.
- Keep `cwd`, environment policy, timeout, output bounds, process cleanup,
  agent resolution, and session binding runtime owned.
- Reject caller-supplied `execute` in specialized factory inputs.
- Preserve executor-neutral public contracts in every specialized factory.
- Do not introduce agent, shell, local, or capability-discriminated task types.
  A raw `defineTask` can call the same executor-neutral context operations as a
  factory-generated task.
- Move workspace and session policy to workflow invocations. Do not redesign
  the fluent builder or add Plan node kinds in this slice.
- Update runtime registries, invocation execution, adapters, fixtures, and
  direct task-definition test fixtures.

## Out of scope

- Fluent-builder redesign, workflow composition, and new Plan node kinds.
- Mastra compiler work.
- Effect removal.
- Runtime scheduling or event migration.

## Implementation plan

1. Replace discriminated task-definition interfaces with one canonical
   Zod-backed executable contract and runtime-owned context.
2. Make specialized factories create ordinary task definitions without exposing
   executor details or accepting caller-supplied execution implementations.
3. Move invocation workspace and session policy out of definitions while
   retaining existing invocation identity, dependency, and admission behavior.
4. Migrate the invocation kernel and private adapter bindings to call every
   task through `execute` after policy admission.
5. Remove execution-discriminator predicates and update public exports,
   registries, adapters, and fixtures.
6. Add compile-time, runtime, malformed-input, direct-argv, cancellation, and
   policy coverage.

## Affected areas

- `libs/seqlane-core/`
- `libs/seqlane-fixtures/`
- `libs/seqlane-runtime/`
- `libs/seqlane-opencode/`
- `libs/seqlane-agent-adapter/`
- `libs/seqlane-acp/`

## Verification

Run `pnpm test:mapping` first.

Then run:

- `pnpm exec nx run seqlane-core:test`
- `pnpm exec nx run seqlane-core:build`
- `pnpm exec nx run seqlane-runtime:test`
- `pnpm exec nx run seqlane-runtime:build`
- `pnpm exec nx run seqlane-opencode:test`
- `pnpm exec nx run seqlane-opencode:build`
- `pnpm exec nx run seqlane-agent-adapter:test`
- `pnpm exec nx run seqlane-agent-adapter:build`
- `pnpm exec nx run seqlane-acp:test`
- `pnpm exec nx run seqlane-acp:build`
- `pnpm exec nx run seqlane-fixtures:test`
- `pnpm exec nx run seqlane-fixtures:build`

## Completion criteria

- `defineTask` requires `execute`.
- Specialized factories supply `execute` and reject a supplied implementation.
- All task implementations run through one runtime `execute` path; no task
  capability or execution discriminator selects a separate dispatch path.
- Workspace and session policy are declared by workflow invocations.
- Shell tasks use direct spawn with `shell: false`; workflow data cannot become
  a parsed command string.
- A completed shell process returns `{ exitCode, stdout, stderr }` regardless
  of its exit code. Spawn, timeout, cancellation, output-limit, and
  unconfirmed-termination failures remain typed task failures.
- Types come from the task schemas.
- Specialized factories expose no executor product types.
- Invalid definitions produce typed validation errors.
- Core, runtime, adapter, and mapping checks pass.

## Outcome

Completed on `mastra-01-unify-executable-task-contract`.

The public DSL now has one Zod-backed `TaskDefinition` with an `execute`
callback and runtime-owned `TaskContext`. Agent and shell factories construct
that same definition. Workspace and session policy are invocation properties;
Plans no longer serialize task execution kinds. Shell tasks return the
canonical exit-code, stdout, and stderr result without treating a nonzero exit
as an invocation failure.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
