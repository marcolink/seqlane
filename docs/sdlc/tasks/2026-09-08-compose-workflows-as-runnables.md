---
id: task.compose-workflows-as-runnables
title: Compose Workflows as Runnables
status: in-progress
owners:
  - core
created: 2026-09-08
updated: 2026-09-11
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Compose Workflows as Runnables

## Objective

Allow a workflow anywhere that a task or runnable is accepted, with typed nested
inputs, outputs, identities, and runtime outcomes.

## Upstream requirements

- `REQ-TASK-003`: Treat workflows as runnables.
- `REQ-PLAN-001`: Keep workflow invocation nodes in the Plan.
- `REQ-COMPAT-001`: Preserve current user-visible behavior.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

- Depends on [task.cut-over-to-mastra-runtime](./2026-09-08-cut-over-to-mastra-runtime.md).

## Scope

- Accept workflow values in task and workflow invocation positions.
- Add typed nested input and output binding.
- Compile nested workflow invocation nodes through the same compiler.
- Preserve parent and child Plan and invocation identity.
- Preserve each child workflow's internal session and workspace policies.
- Add nested success, error, cancellation, and policy tests.

## Out of scope

- New control-flow node kinds.
- Adding a new parallel control-flow node. Independent nested work follows the
  current eligibility and admission concurrency contract.
- Public Mastra types or engine configuration.
- Changes to active session or model policy contracts.

## Implementation plan

1. Add the shared runnable type and schema boundary.
2. Add typed workflow invocation bindings.
3. Lower nested workflows to private compiler input.
4. Preserve identity and policy context across the child boundary.
5. Migrate composition fixtures and examples.

## Affected areas

- `libs/seqlane-core/`
- `libs/seqlane-runtime/`
- `libs/seqlane-fixtures/`
- Public authoring examples and docs.

## Verification

Run `pnpm test:mapping` first.

Then run:

- `pnpm exec nx run seqlane-core:test`
- `pnpm exec nx run seqlane-runtime:test`
- `pnpm exec nx run seqlane-core:build`
- `pnpm exec nx run seqlane-runtime:build`

## Completion criteria

- Workflows pass every runnable acceptance point.
- Nested inputs and outputs remain schema-inferred and typed.
- Parent and child identities remain distinct and traceable.
- A nested workflow does not acquire a synthetic session.
- Nested policy, cancellation, and failure behavior is covered.

## Outcome

Implementation and scoped verification are complete on the dedicated
`feat/compose-workflows-as-runnables` branch. Final delivery is pending the
dedicated pull request.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.cut-over-to-mastra-runtime: Cut Over to the Mastra Runtime](./2026-09-08-cut-over-to-mastra-runtime.md)
