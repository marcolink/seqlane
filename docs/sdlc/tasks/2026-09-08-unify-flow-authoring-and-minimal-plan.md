---
id: task.unify-flow-authoring-and-minimal-plan
title: Unify Flow Authoring and the Minimal Plan
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-10
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Unify Flow Authoring and the Minimal Plan

## Objective

Replace legacy workflow definition with `createFlow(...).task(...).output(...).define()` and lower it to the supported Seqlane Plan.

## Upstream requirements

- `REQ-TASK-002`: Use one workflow authoring API.
- `REQ-PLAN-001`: Keep a small Seqlane Plan boundary.
- `REQ-PLAN-002`: Validate Plan data at runtime.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

- Depends on [task.unify-executable-task-contract](./2026-09-08-unify-executable-task-contract.md).

## Scope

- Implement the single public flow builder.
- Remove `defineWorkflow({ build })` support.
- Lower task invocations, validation checks, validation gates, and bounded
  repeats.
- Define `BoundedRepeatNode.maximumIterations` as a finite integer from 1
  through 1,000 and retain the run-wide 1,000 repeat-body budget.
- Preserve reference-based dependency inference and stable node addresses.
- Validate Plan nodes, bindings, and registry data with Zod.
- Preserve explicit session and workspace policy at invocation boundaries.

## Out of scope

- Mastra graph compilation.
- Runtime admission or session policy changes.
- New parallel, branch, choose, foreach, retry, persistence, or suspension
  nodes. Existing independent work keeps the current concurrency contract.
- Nested workflow invocation and `WorkflowInvocationNode`.
- Effect subprocess replacement.

## Implementation plan

1. Map the current builder, Plan, binding, and registry contracts.
2. Add the `createFlow` chain and typed task overloads.
3. Define the current task, validation, and repeat node schemas.
4. Lower authoring values without executing runnable implementations.
5. Add per-node and run-wide repeat-limit validation, including nested
   accumulation and the exact 1,000 boundary.
6. Migrate fixtures and add malformed-input and composition tests.

## Affected areas

- `libs/seqlane-core/`
- `libs/seqlane-fixtures/`
- Workflow examples and authoring documentation.

## Verification

Run `pnpm test:mapping` first.

Then run:

- `pnpm exec nx run seqlane-core:test`
- `pnpm exec nx run seqlane-core:build`

## Completion criteria

- New workflows use only the single flow API.
- Legacy `defineWorkflow({ build })` is unavailable.
- The Plan contains only the supported node kinds.
- Invocation policies remain serialized and type-safe.
- Repeat limits reject non-finite or out-of-range values and stop before repeat
  execution 1,001.
- Per-node and run-wide exhaustion return their typed errors.
- Plan serialization and malformed-input tests pass.

## Outcome

Delivered in [PR #93](https://github.com/marcolink/seqlane/pull/93) from
`feat/unify-flow-authoring-minimal-plan`.

`createFlow(...).task(...).output(...).define()` is now the sole public
workflow authoring path. The legacy `defineWorkflow({ build })` API and public
Plan-construction helpers were removed, and authored workflow definitions,
examples, and direct tests now use the Flow builder.

Core now validates generated Plans, bindings, and definition registries with
canonical Zod schemas. Repeat limits are constrained to finite integers from 1
through 1,000, and a run rejects its 1,001st repeat-body execution with a typed
error. Focused core and repeat tests pass. The full runtime suite retains an
unchanged baseline failure in the non-cooperative MCP dispatcher-capacity test:
it rejects with `MCP workflow invocation deadline exceeded`.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.unify-executable-task-contract: Unify the Executable Task Contract](./2026-09-08-unify-executable-task-contract.md)
