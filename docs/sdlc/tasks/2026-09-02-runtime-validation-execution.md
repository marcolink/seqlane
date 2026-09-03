---
id: task.runtime-validation-execution
title: Execute Mechanical and Evaluator Validations
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.semantic-validation-gates
supersedes: []
---

# Execute Mechanical and Evaluator Validations

> Migrated from implementation story `TS-015-03`.

## User outcome

As a workflow author, a failed semantic gate stops dependent work with a clear,
structured failure while evaluator tasks retain normal Seqlane lifecycle
behavior.

## Scope

- Thread validator registries through workflow loading and runtime context.
- Execute mechanical callbacks and evaluator tasks.
- Parse inputs and validate `ValidationResult` structure.
- Store candidate/verdict envelopes and release them by consumer lifetime.
- Enforce fail-closed behavior, cancellation, and no implicit retry.
- Implement repeat-postcondition continuation and latest-evidence failures.

## Out of scope

- Runner serialization changes.
- Output or Studio rendering.
- Live model or external-service tests.

## Implementation notes

- Mechanical validators are synchronous and invoked once per check.
- Evaluator tasks use existing executor, schema, cancellation, and one-attempt
  behavior.
- Missing registry entries fail during preparation before task execution.

## Acceptance criteria

**Scenario:** *A failed normal gate stops dependents*

- **Given:** A validator returns `success: false`
- **When:** The gate executes
- **Then:** The run fails with `ValidationError` and dependent tasks do not run

**Scenario:** *An evaluator remains a normal task*

- **Given:** An evaluator task executes
- **When:** It returns a malformed result or executor failure
- **Then:** Existing output-validation or executor error semantics apply

**Scenario:** *Cancellation interrupts evaluation*

- **Given:** An evaluator is running
- **When:** The run is cancelled
- **Then:** Evaluation stops and the run remains cancelled without retry

## Source

- [adr.semantic-validation-gates](../adrs/2026-09-02-semantic-validation-gates.md)
- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
- [spec.mastra-runtime-integration](../specs/2026-09-02-mastra-runtime-integration.md)
- [spec.autonomous-non-interactive-execution](../specs/2026-09-02-autonomous-non-interactive-execution.md)

## Traceability

- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
