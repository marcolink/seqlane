---
id: task.compose-workflows-as-runnables
title: Compose Workflows as Runnables
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-10-22
upstream:
  - spec.workflow-execution-semantics
supersedes: []
---

# Compose Workflows as Runnables

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Allow a workflow anywhere that a task or runnable is accepted, with typed nested
inputs, outputs, identities, and runtime outcomes.

## Upstream requirements

- `REQ-TASK-003`: Treat workflows as runnables.
- `REQ-PLAN-001`: Keep workflow invocation nodes in the Plan.
- `REQ-COMPAT-001`: Preserve current user-visible behavior.
- [spec.workflow-execution-semantics](../specs/2026-10-22-workflow-execution-semantics.md)

## Current replacement

This later task owns replacement work. It was not an original prerequisite.

Current successor owner: [task.effect-v4-complete-removal-and-release](./2026-10-21-effect-v4-complete-removal-and-release.md).

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
- Public runtime-engine types or engine configuration.
- Changes to active session or model policy contracts.

## Implementation plan

1. Add the shared runnable type and schema boundary.
2. Add typed workflow invocation bindings.
3. Lower nested workflows to private compiler input.
4. Preserve identity and policy context across the child boundary.
5. Migrate composition fixtures and examples.

## Affected areas

- `libs/core/`
- `libs/runtime/`
- `libs/fixtures/`
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

Delivered in [PR #99](https://github.com/marcolink/seqlane/pull/99) from
`feat/compose-workflows-as-runnables`.

The implementation adds typed workflow-as-runnable authoring, serializable
workflow invocation nodes, recursive private runtime compilation, distinct
parent and child invocation identities, child policy retention, cancellation
propagation, and workflow Plan snapshot/event validation. Scoped tests,
typechecks, lint, formatting, and SDLC validation passed.

## Traceability

- [spec.workflow-execution-semantics: Workflow Authoring and Execution Semantics](../specs/2026-10-22-workflow-execution-semantics.md)
- [rfc.effect-v4-migration: Full Effect v4 Migration](../rfcs/2026-10-21-effect-v4-migration.md)
- [task.effect-v4-complete-removal-and-release: Complete removal and release gate](./2026-10-21-effect-v4-complete-removal-and-release.md)
