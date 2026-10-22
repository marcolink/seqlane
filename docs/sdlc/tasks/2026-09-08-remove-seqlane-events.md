---
id: task.remove-seqlane-events
title: Remove Seqlane Events
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-10-22
upstream:
  - spec.workflow-execution-semantics
supersedes: []
---

# Remove Seqlane Events

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Delete the transitional `@seqlane/events` package after every consumer uses
the `@seqlane/protocol` serialized contracts.

The public authoring surface remains in `@seqlane/core`. The protocol package
owns runner commands, serialized execution events, errors, and Plan snapshots.
Runtime emission, runtime telemetry, and bounded Studio or recording projections
remain separate.

## Upstream requirements

- [REQ-RUNNER-001: Canonical protocol ownership](../specs/2026-10-22-workflow-execution-semantics.md#req-runner-001-own-serialized-contracts-in-protocol)
- `REQ-COMPAT-001`: Preserve current user-visible behavior.
- [spec.workflow-execution-semantics](../specs/2026-10-22-workflow-execution-semantics.md)

## Dependencies

- Depends on [task.migrate-execution-event-consumers](./2026-09-08-migrate-execution-event-consumers.md).

## Scope

- Prove that no runtime, CLI, output, Studio, fixture, or documentation
  consumer imports `@seqlane/events`.
- Prove that the protocol-owned versioned runner envelope, strict schemas,
  sequence ordering, cancellation semantics, and one terminal event remain
  available.
- Remove the package source, project configuration, tests, exports, and
  workspace dependency entries.
- Remove obsolete event build artifacts from package and release metadata.
- Update architecture and migration documentation.

## Out of scope

- Removing runtime observability.
- Removing runner notifications or typed run outcomes.
- Deleting Studio, recording, or replay.
- Moving the rich in-process event model and event sink out of `@seqlane/core`;
  that is a follow-up runtime-private extraction.

## Implementation plan

1. Search the repository for package and symbol references.
2. Resolve each remaining consumer through the versioned migration contract.
3. Run compatibility and malformed-input tests for notifications and outcomes.
4. Delete the legacy package and add the protocol package and its workspace
   metadata.
5. Update exports, lockfile, fixtures, and documentation.
6. Run the full repository gate and inspect the final dependency graph.

## Affected areas

- `libs/protocol/`
- `libs/runtime/`
- `libs/output/`
- `apps/cli/`
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
- `@seqlane/protocol` owns the replacement serialized contracts without a
  dependency on runtime-engine or executor packages.
- Runner, CLI, output, Studio, recording, and replay checks pass.
- Typed outcomes and narrow notifications remain available.
- No duplicate replacement schema, generic event bus, or runtime-engine type is
  introduced.
- The changed behavior passes every required check.
- Any remaining failure is proven on the unchanged baseline and recorded.
- The active specification and protocol-package ADR remain the migration
  authority.

## Outcome

The legacy `@seqlane/events` package, source, project configuration, and
workspace references are removed. `@seqlane/protocol` owns the replacement
serialized contracts. Current application and runtime consumers use the
replacement package.

## Historical delivery state

Delivered to the default branch through [pull request
#107](https://github.com/marcolink/seqlane/pull/107). This pull request
superseded the closed pull request #104.

## Traceability

- [spec.workflow-execution-semantics: Workflow Authoring and Execution Semantics](../specs/2026-10-22-workflow-execution-semantics.md)
- [rfc.effect-v4-migration: Full Effect v4 Migration](../rfcs/2026-10-21-effect-v4-migration.md)
- [adr.separate-seqlane-protocol-package: Separate Seqlane Protocol Contracts from Core Authoring](../adrs/2026-09-13-separate-seqlane-protocol-package.md)
- [task.migrate-execution-event-consumers: Migrate Execution Event Consumers](./2026-09-08-migrate-execution-event-consumers.md)
