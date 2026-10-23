---
id: task.migrate-execution-event-consumers
title: Migrate Execution Event Consumers
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-10-22
upstream:
  - spec.workflow-execution-semantics
supersedes: []
---

# Migrate Execution Event Consumers

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Move runner, CLI, output, Studio, recording, and replay consumers to the
replacement `@seqlane/protocol` contracts before legacy event-package
deletion.

The replacement contracts are owned by the engine-neutral
`@seqlane/protocol` package. `@seqlane/core` remains the public authoring and
Plan IR package. Runtime code owns rich-event emission and translation. This
task does not add a generic event bus or a second canonical schema.

## Upstream requirements

- [REQ-RUNNER-001: Canonical protocol ownership](../specs/2026-10-22-workflow-execution-semantics.md#req-runner-001-own-serialized-contracts-in-protocol)
- `REQ-COMPAT-001`: Preserve current user-visible behavior.
- [spec.workflow-execution-semantics](../specs/2026-10-22-workflow-execution-semantics.md)

## Current replacement

This later task owns replacement work. It was not an original prerequisite.

Current successor owner: [task.effect-v4-telemetry-and-event-pressure](./2026-10-21-effect-v4-telemetry-and-event-pressure.md).

## Scope

- Migrate runner IPC consumers to narrow notifications and typed outcomes.
- Decode and encode the versioned strict runner envelope and serialized run
  outcome.
- Migrate CLI and output projections.
- Migrate Studio protocol, state, and rendering consumers.
- Preserve recording and replay file behavior.
- Keep the typed Plan snapshot topology-only; exclude inputs, outputs,
  bindings, schemas, callbacks, prompts, and credentials.
- Update downstream active consumer specs in this migration when their owners
  or contract assertions change.
- Preserve run-local sequence ordering, one terminal outcome, cancellation, and
  uncertain-termination classification.
- Add compatibility, version, malformed-notification, malformed-outcome, and
  decode/encoding-failure tests.
- Add IPC, Studio, recording, and replay redaction compatibility tests for the
  topology-only Plan snapshot.
- Remove consumer imports that are no longer required from `@seqlane/events`.

## Out of scope

- Deleting the `@seqlane/events` package.
- Redesigning CLI or Studio behavior.
- Changing private compiler or admission policy.
- Adding persistent event storage.

## Implementation plan

1. Inventory all event imports and runner message consumers.
2. Add the protocol-owned schemas and codecs at the runtime-to-consumer
   boundary.
3. Migrate CLI, output, Studio, recording, and replay in dependency order.
4. Preserve ordering, redaction, bounds, cancellation, and consumer isolation.
5. Add compatibility fixtures for supported protocol versions.
6. Remove obsolete consumer references only after compatibility tests pass.

## Affected areas

- `libs/protocol/`
- `libs/output/`
- `libs/runtime/`
- `apps/cli/`
- `apps/seqlane-studio/`
- `libs/seqlane-studio/`

## Verification

Run `pnpm test:mapping` first.

Then run:

- `pnpm exec nx run protocol:test`
- `pnpm exec nx run seqlane-output:test`
- `pnpm exec nx run seqlane-cli:test`
- `pnpm exec nx run seqlane-studio:test`
- `pnpm exec nx run seqlane-studio-service:test`
- `pnpm exec nx run protocol:build`
- `pnpm exec nx run seqlane-output:build`
- `pnpm exec nx run seqlane-cli:build`
- `pnpm exec nx run seqlane-studio:build`
- `pnpm exec nx run seqlane-studio-service:build`

## Completion criteria

- All in-scope consumers use the replacement contracts.
- CLI, output, Studio, recording, and replay behavior stays compatible.
- Consumer ordering and isolation remain covered.
- Strict versioned schemas reject malformed or unsupported messages.
- Each run has one terminal serialized outcome and no later notification.
- Cancellation and uncertain termination remain distinguishable.
- No consumer requires an undeclared event package transition.
- The package is ready for a separate deletion task.

## Outcome

Runner, CLI, terminal output, recording, and replay consumers use
`@seqlane/protocol`. Strict protocol and consumer tests cover malformed data,
sequence ordering, Plan snapshots, recording, and replay behavior.

## Historical delivery state

Delivered to the default branch through [pull request
#107](https://github.com/marcolink/seqlane/pull/107). This pull request
superseded the closed pull request #104.

## Traceability

- [spec.workflow-execution-semantics: Workflow Authoring and Execution Semantics](../specs/2026-10-22-workflow-execution-semantics.md)
- [rfc.effect-v4-migration: Full Effect v4 Migration](../rfcs/2026-10-21-effect-v4-migration.md)
- [adr.separate-seqlane-protocol-package: Separate Seqlane Protocol Contracts from Core Authoring](../adrs/2026-09-13-separate-seqlane-protocol-package.md)
- [task.effect-v4-telemetry-and-event-pressure: Telemetry sinks and event pressure](./2026-10-21-effect-v4-telemetry-and-event-pressure.md)
