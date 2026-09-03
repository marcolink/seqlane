---
id: task.integration-and-documentation
title: Complete Integration Compatibility Coverage and Documentation
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.model-selection-and-session-model-semantics
supersedes: []
---

# Complete Integration Compatibility Coverage and Documentation

> Migrated from implementation story `TS-022-07`.

## User outcome

As a workflow author, the model-selection contract is documented, compatible
with existing session workflows, and verified through the full repository gate.

## Scope

- Add end-to-end fixture coverage for isolated, reuse, branch, and child model
  selections.
- Verify legacy workflows and Plans without model fields.
- Update package and architecture documentation with examples and constraints.
- Run the complete verification gate and docs-sync review.

## Out of scope

New providers, Codex support, automatic fallback, and unrelated cleanup.

## Acceptance criteria

**Scenario:** *Legacy compatibility*

- **Given:** an existing workflow without model selection
- **When:** it compiles and runs with OpenCode
- **Then:** it resolves the configured executor default without Plan changes

**Scenario:** *Complete workflow*

- **Given:** a workflow using explicit, inherited, and branched selections
- **When:** it runs through the OpenCode fixture adapter
- **Then:** validation, session behavior, fork initialization, and events all
  satisfy adr.model-selection-and-session-model-semantics

## Source

- [adr.model-selection-and-session-model-semantics](../adrs/2026-09-03-model-selection-and-session-model-semantics.md)
- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)

## Traceability

- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)
