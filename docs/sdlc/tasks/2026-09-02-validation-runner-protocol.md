---
id: task.validation-runner-protocol
title: Extend Validation Lifecycle and Runner Protocol
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.semantic-validation-gates
supersedes: []
---

# Extend Validation Lifecycle and Runner Protocol

> Migrated from implementation story `TS-015-04`.

## User outcome

As a CLI, renderer, or integration consumer, I can distinguish task, validator,
and validation-gate invocations and inspect bounded validation failures.

## Scope

- Add the `validation` invocation kind.
- Add discriminated invocation subjects to core and runner events.
- Keep `taskId` as optional compatibility data for task subjects.
- Serialize bounded validation failure details.
- Update protocol guards, encoders, decoders, and bridge coverage.

## Out of scope

- New event families.
- Raw evaluator prompts, model objects, or private executor errors.
- Changes to retry behavior.

## Implementation notes

- Check subjects identify either a validator ID or evaluator task ID.
- Gate subjects identify the validation Plan node.
- Validator evidence uses existing display redaction, truncation, and omission
  rules by default.

## Acceptance criteria

**Scenario:** *Validation events round-trip*

- **Given:** A validation lifecycle event with a validator or gate subject
- **When:** It is encoded and decoded
- **Then:** The event remains valid and equivalent

**Scenario:** *A failed gate is serialized distinctly*

- **Given:** A gate fails with issues and evidence
- **When:** The runner emits its failure
- **Then:** Consumers receive `ValidationError` details within display limits

**Scenario:** *Compatibility task IDs remain unambiguous*

- **Given:** A mechanical validator event
- **When:** It crosses the runner boundary
- **Then:** Its validator identity is not placed in `taskId`

## Source

- [adr.semantic-validation-gates](../adrs/2026-09-02-semantic-validation-gates.md)
- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
- [spec.dedicated-runner-process](../specs/2026-09-02-dedicated-runner-process.md)

## Traceability

- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
