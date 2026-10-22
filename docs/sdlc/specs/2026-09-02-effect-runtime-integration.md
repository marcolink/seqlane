---
id: spec.effect-runtime-integration
title: Effect Runtime Integration
status: superseded
owners:
  - core
created: 2026-09-02
updated: 2026-10-22
upstream:
  - adr.effect-private-runtime-engine
supersedes: []
---

# Effect Runtime Integration

> Superseded by [Effect v4 execution and operations](./2026-10-21-effect-v4-execution-and-operations.md).
> This record describes the earlier, bounded sequential-runtime proposal. It does
> not define the current runtime or establish historical Effect v4 delivery.

## Historical scope

The earlier proposal sought execution parity through a private sequential
runner. It preserved public authoring, Zod validation, serialized Plans,
Seqlane errors, cancellation, and canonical events. It deferred concurrency,
resource admission, hosted operations, and telemetry to later decisions.

That scope is replaced. The current contract requires one scoped Effect v4
program, dependency-driven concurrency, atomic admission, native process and
SDK resource ownership, complete observations, and explicit hosted inspection.
The earlier compatibility facade, dependency-version advice, and execution
recipes no longer define supported implementation work.

## Retained requirements

- Public DSL, Plan, event, and IPC values remain engine-independent and Zod-owned.
- Seqlane owns binding resolution, schemas, validation gates, repeats, and identity.
- Cancellation preserves its domain outcome and reaches owned external work.
- Typed errors preserve their causes without matching error-message text.
- Tests prove results, failure propagation, cleanup, and boundary compatibility.

The current owners below define these contracts and their verification gates.

## Delivery state

Superseded contract. Its lifecycle state proves no delivery on any target branch.
Current migration evidence belongs to the scoped Effect v4 tasks and final release gate.

## Traceability

- [adr.effect-private-runtime-engine — Original private-runtime decision](../adrs/2026-09-02-effect-private-runtime-engine.md)
- [Replacement execution and operations contract](./2026-10-21-effect-v4-execution-and-operations.md)
- [Workflow authoring and execution semantics](./2026-10-22-workflow-execution-semantics.md)
