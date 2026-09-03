---
id: task.authoring-validation-and-task-output
title: Add Authoring Validation and Task Output Validation
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.semantic-validation-gates
supersedes: []
---

# Add Authoring Validation and Task Output Validation

> Migrated from implementation story `TS-015-01`.

## User outcome

As a workflow author, I can validate arbitrary values or a task output using a
small, typed Flow API.

## Scope

- Add direct mechanical definitions and evaluator tasks to `.validate()`.
- Add optional `validateOutput` task authoring options.
- Preserve typed candidate and `validation` handles.
- Apply the same API to the lower-level workflow builder.
- Reject duplicate or widened Flow names at compile time.

## Out of scope

- Repeat postcondition behavior.
- Runtime validation execution.
- New validator composition language.

## Implementation notes

Preferred common path:

```ts
.task("draft", draftTask, binding, { validateOutput: draftValidator })
```

Explicit `.validate()` remains for arbitrary values, final results, and
repeat-body checks. A standalone gate protects only its dependents; raw source
handles remain available for intentionally independent work.

## Acceptance criteria

**Scenario:** *A task output is validated by default for its handle*

- **Given:** A task uses `validateOutput`
- **When:** A later task consumes that task handle
- **Then:** The consumed output is produced only after a passing gate

**Scenario:** *Mechanical and evaluator sources share one API*

- **Given:** `.validate()` receives either a validator definition or evaluator
  task
- **When:** The Flow is type-checked
- **Then:** Both produce the same typed validation handle

**Scenario:** *Flow names are compile-time local handles*

- **Given:** A Flow uses a widened or duplicate name
- **When:** TypeScript checks the Flow
- **Then:** The author receives a type error

## Source

- [adr.semantic-validation-gates](../adrs/2026-09-02-semantic-validation-gates.md)
- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
- [adr.fluent-seqlane-flow-dsl](../adrs/2026-09-02-fluent-seqlane-flow-dsl.md)

## Traceability

- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
