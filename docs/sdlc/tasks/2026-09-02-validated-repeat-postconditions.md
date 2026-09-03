---
id: task.validated-repeat-postconditions
title: Add Validated Repeat Postconditions and Plan Checks
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.semantic-validation-gates
supersedes: []
---

# Add Validated Repeat Postconditions and Plan Checks

> Migrated from implementation story `TS-015-02`.

## User outcome

As a workflow author, I can converge a bounded repeat on a semantic validation
result without writing a boolean adapter task.

## Scope

- Add `validatedBy(validator)` as the repeat `until` form.
- Lower validated postconditions to body-local check and gate nodes.
- Preserve existing boolean `until` behavior.
- Validate repeat scope, ordering, references, and postcondition placement.
- Include latest issues/evidence in loop-limit failures.

## Out of scope

- Parallel iterations.
- Retry or recovery routing.
- General branching.

## Implementation notes

- Exactly one `until` value is required.
- Failed postconditions become the next iteration state.
- The postcondition gate is the final body node and no same-iteration node may
  depend on its result.

## Acceptance criteria

**Scenario:** *A repeat converges on a passing validator*

- **Given:** A validator fails, then passes within the bound
- **When:** The repeat runs
- **Then:** The failed candidate starts the next iteration and the passing
  candidate completes the repeat

**Scenario:** *A repeat exhausts its bound*

- **Given:** Every postcondition fails
- **When:** The maximum iteration count is reached
- **Then:** Seqlane raises `LoopLimitExceededError` with latest evidence

**Scenario:** *Invalid postcondition placement is rejected*

- **Given:** A postcondition gate is outside a repeat body or is not final
- **When:** The Plan is validated
- **Then:** Validation fails before execution

## Source

- [adr.semantic-validation-gates](../adrs/2026-09-02-semantic-validation-gates.md)
- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
- [spec.fluent-seqlane-flow-dsl](../specs/2026-09-02-fluent-seqlane-flow-dsl.md)

## Traceability

- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
