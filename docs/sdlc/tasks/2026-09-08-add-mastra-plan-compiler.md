---
id: task.add-mastra-plan-compiler
title: Add the Mastra Plan Compiler
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Add the Mastra Plan Compiler

## Objective

Compile the validated Seqlane Plan to a private Mastra workflow without adding
Mastra types to core or public authoring contracts.

## Upstream requirements

- `REQ-PLAN-001`: Keep a small Seqlane Plan boundary.
- `REQ-RUNTIME-001`: Compile behind a private boundary.
- `REQ-POLICY-001`: Apply policy after eligibility.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

- Depends on [task.unify-flow-authoring-and-minimal-plan](./2026-09-08-unify-flow-authoring-and-minimal-plan.md).

## Scope

- Add a private Mastra compiler for the supported Plan node kinds.
- Map bindings and stable Plan addresses to private Mastra steps.
- Reuse the invocation kernel for task execution and typed outcomes.
- Preserve serial node start order.
- Adapt Mastra lifecycle signals to Seqlane runtime state.
- Add compiler and compatibility fixtures.

## Out of scope

- Runtime cutover or Effect deletion.
- Concurrent DAG scheduling.
- Public Mastra exports or configuration.
- New Plan node kinds.

## Implementation plan

1. Define the private compiler input and registry boundary.
2. Map each supported node to a Mastra step.
3. Preserve Seqlane node and invocation identities.
4. Integrate the invocation kernel and typed outcome adapter.
5. Add serial, binding, cancellation, and malformed-Plan coverage.

## Affected areas

- `libs/seqlane-runtime/`
- Private Mastra adapter modules.
- `libs/seqlane-fixtures/`

## Verification

Run `pnpm test:mapping` first.

Then run:

- `pnpm exec nx run seqlane-runtime:test`
- `pnpm exec nx run seqlane-runtime:build`
- `pnpm exec nx run seqlane-core:build`

## Completion criteria

- The compiler accepts only validated supported Plan nodes.
- Mastra dependencies stay behind the private runtime boundary.
- The invocation kernel remains the execution path.
- Serial behavior and typed outcomes match existing fixtures.
- Compiler tests cover bindings, identity, cancellation, and malformed data.

## Outcome

Not started.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.unify-flow-authoring-and-minimal-plan: Unify Flow Authoring and the Minimal Plan](./2026-09-08-unify-flow-authoring-and-minimal-plan.md)
