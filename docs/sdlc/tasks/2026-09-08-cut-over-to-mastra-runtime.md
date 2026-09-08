---
id: task.cut-over-to-mastra-runtime
title: Cut Over to the Mastra Runtime
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Cut Over to the Mastra Runtime

## Objective

Make Mastra the only workflow engine, route runtime execution through the
compiler, and remove Effect packages and code.

## Upstream requirements

- `REQ-RUNTIME-001`: Compile behind a private boundary.
- `REQ-RUNTIME-002`: Remove Effect.
- `REQ-POLICY-001`: Apply policy after eligibility.
- `REQ-COMPAT-001`: Preserve current user-visible behavior.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

- Depends on [task.remove-effect-subprocess-runtime](./2026-09-08-remove-effect-subprocess-runtime.md).
- Depends on [task.add-mastra-plan-compiler](./2026-09-08-add-mastra-plan-compiler.md).

## Scope

- Route the runner and runtime through the private Mastra compiler.
- Preserve admission, session, workspace, cancellation, cleanup, and outcomes.
- Keep serial observable behavior during cutover.
- Delete Effect runtime packages, code, imports, and compatibility paths.
- Update package manifests, lockfile, fixtures, and runtime documentation.
- Run the full repository verification gate.

## Out of scope

- Concurrent DAG scheduling.
- Workflow composition changes after the compiler contract.
- Mastra observability enrichment.
- Execution-event consumer deletion.

## Implementation plan

1. Select one runtime entry point for compiler-backed execution.
2. Move policy admission after Mastra eligibility and before start.
3. Compare serial fixtures and outcomes against the existing contract.
4. Remove Effect dependencies and dead code.
5. Run repository-wide checks and record baseline failures separately.

## Affected areas

- `libs/seqlane-runtime/`
- `libs/seqlane-core/`
- `libs/seqlane-opencode/`
- `apps/seqlane-cli/`
- Workspace manifests, lockfile, fixtures, and docs.

## Verification

Run `pnpm test:mapping` first.

Then run the full gate:

- `pnpm install --frozen-lockfile`
- `pnpm run test`
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run build`
- `pnpm run format:check`
- `pnpm exec nx sync:check`
- `git diff --check`

## Completion criteria

- Mastra is the only workflow engine in runtime execution.
- Effect packages, imports, and runtime paths are absent.
- Admission starts work only after dependencies and policy permit it.
- Serial fixtures preserve current outcomes and user-visible behavior.
- Cancellation, cleanup, and typed errors remain covered.
- The changed behavior passes every required check.
- Any remaining failure is proven on the unchanged baseline and recorded.

## Outcome

Not started.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.remove-effect-subprocess-runtime: Remove the Effect Subprocess Runtime](./2026-09-08-remove-effect-subprocess-runtime.md)
- [task.add-mastra-plan-compiler: Add the Mastra Plan Compiler](./2026-09-08-add-mastra-plan-compiler.md)
