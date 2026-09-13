---
id: task.migrate-execution-event-consumers
title: Migrate Execution Event Consumers
status: in-progress
owners:
  - core
created: 2026-09-08
updated: 2026-09-13
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Migrate Execution Event Consumers

## Objective

Move runner, CLI, output, Studio, recording, and replay consumers to the
replacement `@seqlane/protocol` contracts before legacy event-package
deletion.

The replacement contracts are owned by the engine-neutral
`@seqlane/protocol` package. `@seqlane/core` remains the public authoring and
Plan IR package. Runtime code owns rich-event emission and translation. This
task does not add a generic event bus or a second canonical schema.

## Upstream requirements

- `REQ-OBS-002`: Migrate runner and event consumers.
- `REQ-COMPAT-001`: Preserve current user-visible behavior.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

- Depends on [task.add-mastra-observability](./2026-09-08-add-mastra-observability.md).

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
- Changing Mastra compiler or admission policy.
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

Implementation is in progress on `refactor/seqlane-protocol`, with runner,
CLI, output, recording, and replay consumers migrated to `@seqlane/protocol`.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.separate-seqlane-protocol-package: Separate Seqlane Protocol Contracts from Core Authoring](../adrs/2026-09-13-separate-seqlane-protocol-package.md)
- [task.add-mastra-observability: Add Mastra Observability](./2026-09-08-add-mastra-observability.md)
