---
id: task.remove-effect-subprocess-runtime
title: Remove the Effect Subprocess Runtime
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Remove the Effect Subprocess Runtime

## Objective

Replace Effect-based subprocess execution with a private runtime-owned
implementation that preserves cancellation, bounded output, cleanup, and typed
errors.

## Upstream requirements

- `REQ-RUNTIME-002`: Remove Effect.
- `REQ-RUNTIME-001`: Reuse the invocation kernel and typed outcomes.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

- Depends on [task.unify-executable-task-contract](./2026-09-08-unify-executable-task-contract.md).

## Scope

- Replace Effect subprocess process, stream, and cancellation code.
- Accept one executable and argv array and spawn directly with `shell: false`.
- Keep canonical `cwd`, environment policy, timeout, workspace lease, and
  process-group cleanup under runtime control.
- Keep bounded stdout and stderr behavior.
- Keep process-group cleanup on success, error, and cancellation. Quarantine
  the workspace lease when termination cannot be confirmed.
- Preserve typed domain errors and original causes.
- Remove the affected Effect package dependencies and update their tests.

## Out of scope

- Mastra Plan compilation.
- Flow authoring changes.
- Session or workspace policy changes.
- Runner event consumer migration.

## Implementation plan

1. Record the current subprocess observable contract.
2. Implement the private process boundary with explicit cleanup ownership.
3. Adapt the invocation kernel to the replacement boundary.
4. Add hostile-input, argument-boundary, injection, timeout, bounded-output,
   cancellation, cleanup, lease, and error tests.
5. Remove unused Effect imports and package entries.

## Affected areas

- `libs/seqlane-runtime/`
- `libs/seqlane-opencode/`
- Workspace dependency manifests and lockfile.

## Verification

Run `pnpm test:mapping` first.

Then run:

- `pnpm exec nx run seqlane-runtime:test`
- `pnpm exec nx run seqlane-runtime:build`
- `pnpm exec nx run seqlane-opencode:test`
- `pnpm exec nx run seqlane-opencode:build`

## Completion criteria

- No Effect subprocess implementation remains.
- Shell execution uses direct executable-plus-argv spawning with `shell: false`.
- Public task input cannot override runtime `cwd` or environment policy.
- Cancellation either confirms process termination or returns an uncertain
  outcome while the workspace lease remains quarantined.
- Output limits reject oversized output.
- Typed errors preserve causes.
- Runtime and OpenCode focused checks pass.

## Outcome

Not started.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.unify-executable-task-contract: Unify the Executable Task Contract](./2026-09-08-unify-executable-task-contract.md)
