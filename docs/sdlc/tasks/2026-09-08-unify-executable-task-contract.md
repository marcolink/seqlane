---
id: task.unify-executable-task-contract
title: Unify the Executable Task Contract
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
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

## Scope

- Define the shared task shape with Zod input and output schemas.
- Require `execute` in `defineTask`.
- Make `defineAgentTask` and `defineShellTask` provide `execute`.
- Reject caller-supplied `execute` in specialized factory inputs.
- Preserve executor-neutral public contracts in every specialized factory.
- Update runtime registries, invocation execution, adapters, and fixtures.

## Out of scope

- Flow builder changes.
- Mastra compiler work.
- Effect removal.
- Runtime scheduling or event migration.

## Implementation plan

1. Locate the current task definitions and schema ownership.
2. Add one canonical Zod-backed task contract.
3. Adapt the specialized factories to construct that contract.
4. Migrate the invocation kernel and private adapter bindings.
5. Remove duplicate runtime predicates and update public exports.
6. Add compile-time, runtime, and malformed-input coverage.

## Affected areas

- `libs/seqlane-core/`
- `libs/seqlane-fixtures/`
- `libs/seqlane-runtime/`
- `libs/seqlane-opencode/`

## Verification

Run `pnpm test:mapping` first.

Then run:

- `pnpm exec nx run seqlane-core:test`
- `pnpm exec nx run seqlane-core:build`
- `pnpm exec nx run seqlane-runtime:test`
- `pnpm exec nx run seqlane-runtime:build`
- `pnpm exec nx run seqlane-opencode:test`
- `pnpm exec nx run seqlane-opencode:build`

## Completion criteria

- `defineTask` requires `execute`.
- Specialized factories supply `execute` and reject a supplied implementation.
- Types come from the task schemas.
- Specialized factories expose no executor product types.
- Invalid definitions produce typed validation errors.
- Core, runtime, adapter, and mapping checks pass.

## Outcome

Not started.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
