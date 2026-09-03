---
id: task.effect-workflow-surface
title: Add the Private Effect Workflow Surface
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.effect-runtime-integration
supersedes: []
---

# Add the Private Effect Workflow Surface

> Migrated from implementation story `TS-019-00`.

## User outcome

As a runtime maintainer, I have a private Effect-backed workflow surface that
can run ordered steps without changing public Seqlane contracts.

## Scope

- Add the pinned `effect` dependency to `@seqlane/runtime`.
- Add a private Effect workflow surface for ordered steps and one run.
- Give each step a Seqlane-owned ID and an `AbortSignal`.
- Support commit, start, and idempotent cancellation.
- Keep all Effect values and types inside the runtime package.
- Add focused tests for ordered execution and cancellation.

## Out of scope

- Compiling a Plan with the new surface.
- Removing the Mastra compiler or dependency.
- Changing public exports, events, IPC, executors, retries, or concurrency.

## Implementation notes

Pin one current stable Effect v3 version. Do not use Effect v4-only APIs.
The surface is private. It must not export Effect objects, causes, exits, or
types through the package root. Cancellation must abort the step signal and
must be safe before start and on repeated calls.

## Acceptance criteria

**Scenario:** *Ordered steps run once*

- **Given:** A committed private workflow with three ordered steps
- **When:** A run starts
- **Then:** Each step runs once in its declared order
- **And:** Each step gets its Seqlane-owned ID and an `AbortSignal`

**Scenario:** *Cancellation is idempotent*

- **Given:** A private workflow with a running step
- **When:** The caller cancels the run more than once
- **Then:** The step signal becomes aborted
- **And:** The run reports cancellation once

**Scenario:** *Effect stays private*

- **Given:** The runtime package builds
- **When:** A consumer imports its package root
- **Then:** The public types contain no Effect values or types

## Source

- [adr.effect-private-runtime-engine](../adrs/2026-09-02-effect-private-runtime-engine.md)
- [spec.effect-runtime-integration](../specs/2026-09-02-effect-runtime-integration.md)

## Traceability

- [spec.effect-runtime-integration](../specs/2026-09-02-effect-runtime-integration.md)
