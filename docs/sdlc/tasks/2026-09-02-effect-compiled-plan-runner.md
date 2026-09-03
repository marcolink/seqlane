---
id: task.effect-compiled-plan-runner
title: Run Compiled Plans with Effect
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.effect-runtime-integration
supersedes: []
---

# Run Compiled Plans with Effect

> Migrated from implementation story `TS-019-01`.

## User outcome

As a workflow user, a valid Plan runs with the same ordered Seqlane behavior
when the runtime uses Effect.

## Scope

- Compile each ordered Plan node into the private Effect workflow surface.
- Retain the private result step for workflow output resolution.
- Preserve task, repeat, validation check, and validation gate execution.
- Preserve deterministic serial order and zero retries.
- Map successful completion to the existing Seqlane run outcome and events.
- Update parity tests for successful execution and output resolution.

## Out of scope

- Cancellation and error mapping changes beyond the current behavior.
- Removing all Mastra artifacts.
- Parallel execution, retries, durable runs, or public contract changes.

## Implementation notes

Reuse Seqlane node execution functions. Do not put Effect types in
`CompiledWorkflow`, core, event payloads, IPC, or executor requests. Keep
independent nodes serial and use the existing deterministic Plan ordering.

## Acceptance criteria

**Scenario:** *A Plan completes*

- **Given:** A valid Plan with dependent and independent nodes
- **When:** The runtime starts the compiled Plan
- **Then:** Nodes execute in the existing deterministic serial order
- **And:** The runtime emits the existing successful outcome

**Scenario:** *Workflow output resolves*

- **Given:** A successful Plan with an output binding
- **When:** Its private result step runs
- **Then:** The outcome contains the existing resolved output

**Scenario:** *Execution policy is unchanged*

- **Given:** A Plan with independent nodes
- **When:** The runtime executes it
- **Then:** The runtime starts one node at a time
- **And:** The runtime does not retry a failed node

## Source

- [adr.effect-private-runtime-engine](../adrs/2026-09-02-effect-private-runtime-engine.md)
- [spec.effect-runtime-integration](../specs/2026-09-02-effect-runtime-integration.md)

## Traceability

- [spec.effect-runtime-integration](../specs/2026-09-02-effect-runtime-integration.md)
