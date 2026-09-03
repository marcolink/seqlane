---
id: task.execution-key-contracts
title: Add Executor-Neutral Agent Keys
status: planned
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.runtime-resolved-execution-profiles
supersedes: []
---

# Add Executor-Neutral Agent Keys

> Migrated from implementation story `TS-018-00`.

## User outcome

As a workflow author, I can assign an opaque agent key to a
workflow or task without adding provider or executor data to the Plan.

## Scope

- Add optional `agent` fields to workflow and task definitions.
- Validate non-empty keys and reject surrounding whitespace.
- Define task-over-workflow precedence in authoring/runtime contracts.
- Reject conflicting task definitions with one task ID.
- Prove that agent keys do not enter serialized Plans.

## Out of scope

- Runtime profile registries.
- OpenCode configuration.
- Direct model IDs.
- Profile resolution and live validation.
- Warning events and session transitions.

## Implementation notes

Keep the key type executor-neutral. Do not add OpenCode, provider, model,
tool, permission, gateway, or runtime configuration types to `seqlane-core`.
Keep agent metadata with in-memory workflow and task definitions.

## Acceptance criteria

**Scenario:** *A workflow defines an agent key*

- **Given:** A workflow has a valid non-empty `agent` key
- **When:** The workflow builds a Plan
- **Then:** The definition retains the key and the Plan does not contain it

**Scenario:** *A task defines an agent key*

- **Given:** A task has a valid non-empty `agent` key
- **When:** The task is invoked in a workflow
- **Then:** The task definition retains the key and the Plan does not contain it

**Scenario:** *An invalid key is rejected*

- **Given:** A workflow or task has an empty, whitespace-only, or surrounding-whitespace key
- **When:** Core validates the definition
- **Then:** Validation fails without normalizing the key

**Scenario:** *Conflicting task definitions are rejected*

- **Given:** One built workflow registers one task ID with different agent keys
- **When:** The workflow builds
- **Then:** Build fails with a typed conflict error

## Source

- [adr.runtime-resolved-execution-profiles](../adrs/2026-09-02-runtime-resolved-execution-profiles.md)
- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)

## Traceability

- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)
