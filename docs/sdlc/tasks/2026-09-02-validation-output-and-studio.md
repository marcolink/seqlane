---
id: task.validation-output-and-studio
title: Project Validation Through Output and Studio
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.semantic-validation-gates
supersedes: []
---

# Project Validation Through Output and Studio

> Migrated from implementation story `TS-015-05`.

## User outcome

As a workflow observer, I can understand validation status, issues, and bounded
evidence in terminal, CI, JSON, and Studio views.

## Scope

- Extend output event reducers and human/CI/JSON renderers.
- Extend Studio protocol, registry, browser projection, and inspector display.
- Preserve redaction, truncation, omission, and executor-neutral boundaries.
- Keep failed repeat postconditions visibly distinct from failed gates.

## Out of scope

- Interactive approval.
- Persistent validation history.
- Browser control of execution.

## Implementation notes

- Reuse existing invocation lifecycle and display-value model.
- A normal failed gate is failed; a repeat postcondition returning false is a
  successful validation operation that continues the repeat.

## Acceptance criteria

**Scenario:** *A terminal view explains a validation failure*

- **Given:** A normal gate fails
- **When:** Human or CI output renders the event stream
- **Then:** It shows validation identity, failure, issues, and bounded evidence

**Scenario:** *Studio displays a validation verdict*

- **Given:** A validation invocation emits input and result
- **When:** Studio projects the run
- **Then:** The invocation kind, subject, verdict, and display state are visible

**Scenario:** *Sensitive evidence is bounded*

- **Given:** Evidence is redacted, truncated, or omitted by policy
- **When:** Output or Studio renders it
- **Then:** No raw value bypasses the existing display policy

## Source

- [adr.semantic-validation-gates](../adrs/2026-09-02-semantic-validation-gates.md)
- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
- [spec.seqlane-execution-output-package](../specs/2026-09-02-seqlane-execution-output-package.md)
- [spec.local-read-only-execution-studio](../specs/2026-09-02-local-read-only-execution-studio.md)

## Traceability

- [spec.semantic-validation-gates](../specs/2026-09-02-semantic-validation-gates.md)
