---
id: task.release-unused-results
title: Release Unused Execution Results
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.fluent-seqlane-flow-dsl
supersedes: []
---

# Release Unused Execution Results

> Migrated from implementation story `TS-012-05`.

## Use Case

**As a** Seqlane operator, **I want** completed values released after their
final use, **so that** long workflows and repeats do not retain all outputs.

## Scope

- Compute remaining consumers for task and Plan-output references.
- Release a result after its final task consumer and final-output use.
- Compute body consumers for every repeat iteration.
- Retain current repeat state and final result only.
- Preserve event summaries before value release.
- Add focused liveness tests.

## Out of Scope

- Persistent output storage or replay.
- Changes to task output schemas or executor output transport.

## Implementation Notes

References repeated in one task input count as one consumer. A final-output
reference keeps its source until final output resolution. A repeat releases
prior state after its next state becomes available.

## Acceptance Criteria

**Scenario:** *A DAG result releases after final consumption*

- **Given:** One task output with two downstream consumers
- **When:** The second consumer resolves its input
- **Then:** The runtime removes the source value from its private result map

**Scenario:** *A final-output value remains available*

- **Given:** A task output referenced by the workflow output
- **When:** Its last task consumer completes
- **Then:** The runtime retains the value until final output resolution

**Scenario:** *A repeat retains bounded state*

- **Given:** A repeat with more than one iteration
- **When:** The next state is available
- **Then:** The runtime releases the prior state and completed body values

## Source

- [adr.fluent-seqlane-flow-dsl — Fluent Seqlane Flow DSL](../adrs/2026-09-02-fluent-seqlane-flow-dsl.md)
- [spec.fluent-seqlane-flow-dsl — Fluent Flow DSL and Conditioned Repeat](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)
- [rfc.execution-observability-and-debugging — Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)

## Traceability

- [spec.fluent-seqlane-flow-dsl](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)
