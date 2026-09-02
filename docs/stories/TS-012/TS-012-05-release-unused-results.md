# TS-012-05 — Release Unused Execution Results

**Status:** completed

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

- [ADR-012 — Fluent Seqlane Flow DSL](../../ADR-012-fluent-seqlane-flow-dsl.md)
- [TS-012 — Fluent Flow DSL and Conditioned Repeat](../../TS-012-fluent-seqlane-flow-dsl.md)
- [RFC-002 — Execution Observability and Debugging](../../RFC-002-execution-observability-and-debugging.md)
