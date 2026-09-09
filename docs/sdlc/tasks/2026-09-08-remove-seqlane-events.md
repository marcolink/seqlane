---
id: task.remove-seqlane-events
title: Remove Seqlane Events
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Remove Seqlane Events

## Objective

Delete the transitional `@seqlane/events` package after every consumer uses the
replacement observability, notification, and typed outcome contracts.

The replacement runner schemas and inferred types remain owned by the
engine-neutral `@seqlane/core` runner-protocol boundary. Runtime emission,
Mastra telemetry, and bounded Studio or recording projections remain separate.

## Upstream requirements

- `REQ-OBS-002`: Migrate runner and event consumers.
- `REQ-COMPAT-001`: Preserve current user-visible behavior.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

- Depends on [task.migrate-execution-event-consumers](./2026-09-08-migrate-execution-event-consumers.md).

## Scope

- Prove that no runtime, CLI, output, Studio, fixture, or documentation
  consumer imports `@seqlane/events`.
- Prove that the core-owned versioned runner envelope, strict schemas, sequence
  ordering, cancellation semantics, and one terminal outcome remain available.
- Remove the package source, project configuration, tests, exports, and
  workspace dependency entries.
- Remove obsolete event build artifacts from package and release metadata.
- Update architecture and migration documentation.

## Out of scope

- Removing Mastra observability.
- Removing runner notifications or typed run outcomes.
- Deleting Studio, recording, or replay.
- Redesigning event semantics.

## Implementation plan

1. Search the repository for package and symbol references.
2. Resolve each remaining consumer through the versioned migration contract.
3. Run compatibility and malformed-input tests for notifications and outcomes.
4. Delete the package and its workspace metadata.
5. Update exports, lockfile, fixtures, and documentation.
6. Run the full repository gate and inspect the final dependency graph.

## Affected areas

- `libs/seqlane-events/`
- `libs/seqlane-runtime/`
- `libs/seqlane-output/`
- `apps/seqlane-cli/`
- `apps/seqlane-studio/`
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
- `pnpm docs:validate`
- `git diff --check`

## Completion criteria

- `@seqlane/events` has no source, project, export, or dependency reference.
- Runner, CLI, output, Studio, recording, and replay checks pass.
- Typed outcomes and narrow notifications remain available.
- No duplicate replacement schema, generic event bus, or Mastra type is
  introduced.
- The changed behavior passes every required check.
- Any remaining failure is proven on the unchanged baseline and recorded.
- The active specification and ADR remain the only migration authority.

## Outcome

Not started.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.migrate-execution-event-consumers: Migrate Execution Event Consumers](./2026-09-08-migrate-execution-event-consumers.md)
