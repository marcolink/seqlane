---
id: adr.separate-seqlane-protocol-package
title: Separate Seqlane Protocol Contracts from Core Authoring
status: accepted
owners:
  - core
created: 2026-09-13
updated: 2026-09-16
upstream:
  - adr.mastra-backed-seqlane-workflows
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Separate Seqlane Protocol Contracts from Core Authoring

## Context

`@seqlane/core` is the public surface for creating executor-neutral workflows
and the Plan IR used by that authoring API. Runner commands, serialized
execution events, codecs, and IPC envelopes are transport contracts. Keeping
those contracts in core couples the authoring package to process boundaries and
makes its public surface grow with internal execution concerns.

The former `@seqlane/events` package already contains the serialized execution
event schemas and codecs, but it is being removed as a transitional package.
The replacement must preserve the wire contracts without moving transport
concerns into core.

## Decision

Create `@seqlane/protocol` as the public, executor-neutral package for
cross-process Seqlane contracts. It owns:

- `RunnerCommand`, `WorkflowReference`, and `RuntimeProfileReference`;
- `SeqlaneExecutionEvent` and its metadata, schemas, codecs, and serialized
  errors;
- sanitized `SeqlanePlanSnapshot` contracts.

`@seqlane/protocol` may depend on stable primitives from `@seqlane/core`.
`@seqlane/core` must not depend on protocol and must not export runner or
serialized-event contracts.

The runtime remains the owner of rich in-process execution behavior. It emits
`SeqlaneEvent` values, translates them into protocol events, and sends encoded
messages through its private execution path. CLI and other application
surfaces own consumer dispatch and recording lifecycle. This decision does not
create a generic event bus.

The rich `SeqlaneEvent`, `SeqlaneEventSink`, and `SeqlaneRunOutcome` extraction
from core into runtime-private code is a follow-up migration. This package
migration keeps those in-process contracts stable while removing the serialized
and runner protocol dependency from core.

## Dependency boundary

```text
protocol ─────▶ core
runtime  ─────▶ core + protocol
output   ─────▶ protocol
cli      ─────▶ core + runtime + protocol + output
```

Mastra and executor types remain behind runtime. They must not appear in core,
protocol, serialized Plans, or public workflow-authoring contracts.

## Alternatives considered

### Keep runner and serialized contracts in core

Rejected. It makes the authoring package own transport and IPC concerns and
expands the stable public surface with runtime-internal contracts.

### Keep `@seqlane/events` as the protocol package

Rejected. Its name describes one contract family, while the replacement also
owns runner commands and IPC references. A protocol package gives both
families one explicit transport boundary.

### Move all event types into protocol immediately

Rejected for this migration slice. Rich in-process events and sinks have
different ownership and lifecycle semantics from serialized cross-process
messages. Moving them in the same change would increase the blast radius
without improving the wire boundary.

## Consequences

Consumers import serialized events, runner commands, and Plan snapshots from
`@seqlane/protocol`. Core remains focused on workflow creation and Plan
authoring. The package graph gains one public protocol node and removes the
legacy events node. A later runtime-private extraction can reduce core further
without another serialized-contract migration.

## Delivery state

Delivered to the default branch through [pull request
#107](https://github.com/marcolink/seqlane/pull/107). The ADR remains the
historical decision record.

## Traceability

- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](./2026-09-08-mastra-backed-seqlane-workflows.md)
- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.remove-seqlane-events: Remove Seqlane Events](../tasks/2026-09-08-remove-seqlane-events.md)
- [task.migrate-execution-event-consumers: Migrate Execution Event Consumers](../tasks/2026-09-08-migrate-execution-event-consumers.md)
