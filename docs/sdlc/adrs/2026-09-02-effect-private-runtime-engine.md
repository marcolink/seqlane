---
id: adr.effect-private-runtime-engine
title: Use Effect as Seqlane's Private Runtime Engine
status: accepted
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - rfc.seqlane-technical-architecture
supersedes:
  - adr.mastra-internal-workflow-engine
---

# Use Effect as Seqlane's Private Runtime Engine

## Context

adr.mastra-internal-workflow-engine selected Mastra as Seqlane's private workflow engine. The current
runtime uses a small part of that engine. It creates one internal step for
each ordered Plan node, chains the steps in sequence, starts one run, and
forwards cancellation.

Seqlane owns the workflow meaning. Seqlane also owns Plan validation,
dependency ordering, input binding, task execution, validation gates, repeats,
identities, errors, and execution events. Mastra does not own these contracts.

This leaves a narrow engine adapter, but the adapter adds a second workflow
model and engine-specific result and cancellation handling. The current
dependency is also an alpha release. The runtime needs a private execution
foundation that fits Seqlane's existing contracts and can support later
controlled concurrency without changing public authoring.

The following constraints remain in force:

- `seqlane-core` remains independent of runtime libraries.
- Plans, runner IPC, events, and workflow authoring remain engine-neutral.
- Each run remains in its dedicated child process.
- V1 remains autonomous and non-interactive.
- Automatic retries remain disabled until Seqlane defines retry policy.
- Seqlane's existing Zod-based schema contracts remain unchanged.

## Options Considered

### Keep Mastra

This keeps the current implementation stable. It also keeps the workflow
adapter, engine-specific lifecycle, and alpha dependency. It does not reduce
the boundary that Seqlane must maintain. Rejected.

### Use Effect core as the private runtime foundation

Effect provides lazy effect descriptions, typed errors and requirements,
fiber interruption, concurrency control, resource scopes, and schedules. The
runtime can use these primitives while Seqlane keeps ownership of Plan and
event semantics. Chosen.

### Use `@effect/workflow` as the runtime engine

`@effect/workflow` provides durable workflow features, activities, deferred
signals, polling, resumption, and persistence-oriented execution. These
features exceed the current local, foreground, single-run model. The package
also introduces a 0.x API, Effect Schema workflow contracts, idempotency and
replay semantics, and peer dependencies beyond `effect`. These changes would
make the first migration larger and add behavior that Seqlane has not
defined. Deferred until durable and resumable execution becomes a requirement.

### Build a Promise-based Seqlane scheduler

This can remove Mastra with little dependency cost. It does not provide the
Effect runtime model for interruption, resource scopes, typed errors, or later
bounded concurrency. Rejected.

## Decision

Seqlane will use the `effect` core package as the private runtime foundation
in `@seqlane/runtime`. `@effect/workflow` is not part of the first
migration.

The first implementation will preserve current observable behavior. It will
execute the ordered Plan serially, emit the same Seqlane events, preserve the
same run outcomes, and use the existing executor and `AbortSignal` contracts.

The migration will replace the private Mastra workflow surface with an
Effect-backed sequential runner. It will keep the current compiler and run
seams where this reduces migration risk. These seams are private and must not
expose Effect types, Mastra types, or engine-specific objects.

Effect will not become part of `seqlane-core`, serialized Plans, workflow
authoring, runner IPC, or the public event contract.

Parallel scheduling, automatic retries, durable execution, persistence,
resume, and human interaction are separate decisions. They are not part of
the first migration.

## Consequences

### Positive

- The runtime removes its direct Mastra dependency.
- Seqlane keeps one authoritative execution model.
- Cancellation can use Effect interruption while preserving executor signals.
- Resource cleanup can use Effect scopes.
- Future bounded concurrency can use Effect fibers without changing Plans.
- Public Seqlane contracts remain stable during the migration.

### Negative

- Seqlane owns the scheduler behavior that Mastra provided.
- The runtime must map Effect failures and interruption to Seqlane errors and
  outcomes.
- Effect types and Seqlane types must not cross the private runtime boundary.
- A later durable workflow design will need separate persistence and
  idempotency decisions.
- Initial execution remains serial and does not gain a performance benefit.
- Durable execution remains unavailable until Seqlane defines persistence,
  replay, idempotency, and recovery semantics.

## Follow-up Constraints

- Keep the first migration serial. Do not add concurrency as an incidental
  change.
- Keep retries at zero. Do not apply Effect schedules to task execution.
- Preserve Seqlane event order and event payloads during parity testing.
- Preserve `AbortSignal` support for executor and OpenCode cancellation.
- Do not migrate Zod schemas to Effect Schema in this work.
- Do not add `@effect/workflow`, `@effect/cluster`, or persistence services.
- Reconsider `@effect/workflow` only through a separate durable-execution
  decision.
- Do not change Plan, runner IPC, CLI, Studio, or OpenCode contracts.
- Add a separate decision before enabling parallel or durable execution.

## Revisit Conditions

Revisit this decision if Effect core cannot preserve required cancellation or
resource behavior, if runtime maintenance becomes greater than the current
adapter cost, or if Seqlane needs durable execution that requires a different
workflow engine boundary.

## Sources

- [Effect type](https://effect.website/docs/v4/getting-started/the-effect-type)
- [Effect concurrency](https://effect.website/docs/v4/concurrency/basic-concurrency)
- [Effect resource scopes](https://effect.website/docs/v4/resource-management/scope)
- [Effect retrying](https://effect.website/docs/v4/error-management/retrying)
- [Effect package](https://www.npmjs.com/package/effect)
- [Effect workflow package](https://www.npmjs.com/package/@effect/workflow)
- [Effect workflow source](https://github.com/Effect-TS/effect/tree/main/packages/effect/src/unstable/workflow)
- [Snyk package page](https://security.snyk.io/package/npm/effect)
- [Snyk workflow package page](https://security.snyk.io/package/npm/%40effect%2Fworkflow)

## Traceability

- [rfc.seqlane-technical-architecture: Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
