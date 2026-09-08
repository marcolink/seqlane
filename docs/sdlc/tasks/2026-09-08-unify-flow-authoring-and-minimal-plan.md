---
id: task.unify-flow-authoring-and-minimal-plan
title: Unify Flow Authoring and the Minimal Plan
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
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
- Preserve reference-based dependency inference and stable node addresses.
- Validate Plan nodes, bindings, and registry data with Zod.
- Preserve explicit session and workspace policy at invocation boundaries.

## Out of scope

- Mastra graph compilation.
- Runtime admission or session policy changes.
- Parallel, branch, choose, foreach, retry, persistence, or suspension nodes.
- Nested workflow invocation and `WorkflowInvocationNode`.
- Effect subprocess replacement.

## Implementation plan

1. Map the current builder, Plan, binding, and registry contracts.
2. Add the `createFlow` chain and typed task overloads.
3. Define the current task, validation, and repeat node schemas.
4. Lower authoring values without executing runnable implementations.
5. Migrate fixtures and add malformed-input and composition tests.

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
- Plan serialization and malformed-input tests pass.

## Outcome

Not started.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.unify-executable-task-contract: Unify the Executable Task Contract](./2026-09-08-unify-executable-task-contract.md)
