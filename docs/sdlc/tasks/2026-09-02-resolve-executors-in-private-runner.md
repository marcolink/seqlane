---
id: task.resolve-executors-in-private-runner
title: Resolve executors in the private runner
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.executor-neutral-workflow-authoring
supersedes: []
---

# Resolve executors in the private runner

> Migrated from implementation story `TS-008-01`.

## Use Case

**As a** Seqlane operator, **I want to** have the runner privately resolve generic tasks to executors, **so that** workflow source and Plans cannot choose a backend.

## Scope

- Replace the executor-name registry with a private agent resolver in runtime internals.
- Pass the generic in-memory task registry to compilation and execution.
- Resolve each task before executor invocation.
- Map a missing private binding to the existing Seqlane executor failure path.
- Remove `createRunnerExecution` from workflow module loading and exported workflow contracts.
- Keep resolver types out of package-root exports and runner IPC.

## Out of Scope

- OpenCode adapter implementation or runtime profile format.
- CLI flags and public protocol fields.
- Multiple executor selection policies or fallback.
- Public executor registration.

## Implementation Notes

The resolver is runner-owned private state. It receives an agent task definition and returns a private executor. The runtime resolves and validates input before execution and validates output after execution. A missing mapping must identify the Seqlane task ID without exposing private adapter details.

## Acceptance Criteria

**Scenario:** *The runner resolves a generic task privately*
- **Given:** A loaded workflow with agent task definitions and a private resolver
- **When:** The runtime executes a task node
- **Then:** It calls the private executor without reading an executor field from the Plan

**Scenario:** *A missing binding fails deterministically*
- **Given:** A generic task with no private executor binding
- **When:** The runtime reaches its node
- **Then:** It emits the existing invocation and Run failure events as an executor failure and starts no downstream task

**Scenario:** *Workflow modules expose no execution factory*
- **Given:** A workflow module that exports only a generic workflow
- **When:** The runner loads the module
- **Then:** It builds the Plan and obtains private execution state from the runner, not from a module `createRunnerExecution` export

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.mastra-internal-workflow-engine — Use Mastra as Seqlane’s Internal Workflow Engine](../adrs/2026-09-02-mastra-internal-workflow-engine.md)
- [adr.executor-neutral-workflow-authoring — Keep Workflow Authoring and Plans Executor-Neutral](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.executor-neutral-workflow-authoring — Executor-Neutral Workflow Authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)

## Traceability

- [spec.executor-neutral-workflow-authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)
