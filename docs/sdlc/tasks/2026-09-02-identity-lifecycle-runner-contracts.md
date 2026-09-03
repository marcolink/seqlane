---
id: task.identity-lifecycle-runner-contracts
title: Establish core and runtime execution identity
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.work-run-invocation-identity-model
supersedes: []
---

# Establish core and runtime execution identity

> Migrated from implementation story `TS-007-01`.

## User Outcome

**As a** Seqlane operator, **I want** every runtime lifecycle event to contain a generated execution hierarchy, **so that** I can correlate outcomes without relying on a static Task ID.

## Scope

- Add core-owned `WorkId`, `RunId`, and runtime `InvocationId` vocabulary.
- Require Work/Run identity on every run event and Work/Run/Invocation identity on every invocation event.
- Update serializable `RunnerEvent` shapes, guards, encoders, decoders, and protocol tests.
- Allocate a distinct Work/Run pair in the private runner and thread it through execution context, compiler, terminal outcomes, and runner events.
- Allocate one runtime Invocation ID per executed Plan node; retain the private `PlanNodeId → InvocationId` mapping and pass Invocation ID to private executor requests.
- Use injected private identity factories in runtime tests without exporting generators through core or IPC.
- Keep `RunRequest` client-neutral: no Work ID, continuation selector, or user-supplied execution ID.

## Out of Scope

- CLI presentation and child-process integration tests.
- Work persistence, continuation, lookup, or selection.
- Persistent identity records, Git trailers, or commit lookup.

## Implementation Notes

Wire identities are non-empty Seqlane-owned strings. Protocol guards must use exact keys and reject old event forms lacking the required hierarchy. The runner allocates Work/Run before `run.started`, including before load or validation failures. The compiler uses Plan-node addresses for bindings but emits runtime Invocation IDs and sends them to private executors. Task ID stays only on `invocation.started` as reusable-definition provenance; it must not replace `invocationId` on any event.

## Acceptance Criteria

**Scenario:** *Lifecycle events carry the canonical hierarchy*
- **Given:** a Seqlane run or task invocation lifecycle transition
- **When:** core represents the transition
- **Then:** run events include `workId` and `runId`, while invocation events additionally include `invocationId`

**Scenario:** *Runner IPC rejects incomplete correlation data*
- **Given:** an encoded runner event missing, empty, unknown, or non-string identity data
- **When:** the protocol decodes it
- **Then:** it rejects the event before it reaches the runner client

**Scenario:** *A client cannot select Work in the MVP*
- **Given:** a `run.start` command with a Work selector or execution identity field
- **When:** the protocol validates it
- **Then:** it rejects the command

**Scenario:** *Runtime allocation distinguishes static and concrete identity*
- **Given:** a runner executes a static Plan containing repeated Task definitions
- **When:** each Plan node executes
- **Then:** every event shares one distinct Work/Run pair, each node has a distinct runtime Invocation ID, and bindings still use only Plan-node addresses

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.work-run-invocation-identity-model — Distinguish Work, Run, and Invocation Identity](../adrs/2026-09-02-work-run-invocation-identity-model.md)
- [spec.work-run-invocation-identity-model — Work, Run, and Invocation Identity Model](../specs/2026-09-02-work-run-invocation-identity-model.md)
- [spec.mastra-runtime-integration — Mastra Runtime Integration](../specs/2026-09-02-mastra-runtime-integration.md)
- [spec.dedicated-runner-process — Dedicated Runner Process and CLI IPC](../specs/2026-09-02-dedicated-runner-process.md)

## Traceability

- [spec.work-run-invocation-identity-model](../specs/2026-09-02-work-run-invocation-identity-model.md)
