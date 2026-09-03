---
id: task.execution-preflight
title: Add Agent Preflight and Aggregate Validation
status: planned
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.runtime-resolved-execution-profiles
supersedes: []
---

# Add Agent Preflight and Aggregate Validation

> Migrated from implementation story `TS-018-02`.

## User outcome

As a workflow operator, I receive all agent configuration failures before
Seqlane creates an OpenCode session or starts a task.

## Scope

- Collect workflow, task, repeat-body, and evaluator agent keys.
- Apply task, workflow, and runtime-default precedence.
- Resolve each distinct key and retain all source references.
- Validate static adapter dependencies.
- Perform required live gateway/model availability checks.
- Aggregate typed preflight issues.
- Prevent session creation when preflight fails.

## Out of scope

- OpenCode prompt-level transitions.
- Warning event consumers.
- Direct model IDs.
- Dynamic agent keys.
- Multi-session execution.

## Implementation notes

Run preflight after workflow loading and Plan construction, but before runtime
session creation. Mechanical validators do not require profiles. Task-backed
validators do. Treat unavailable live validation as an error. Preserve
original adapter causes.

## Acceptance criteria

**Scenario:** *Task precedence wins*

- **Given:** A workflow has one agent key and a task has another
- **When:** Preflight resolves the task
- **Then:** The task key is selected

**Scenario:** *Workflow precedence applies*

- **Given:** A workflow has an agent key and a task has none
- **When:** Preflight resolves the task
- **Then:** The workflow key is selected

**Scenario:** *The runtime default applies*

- **Given:** A workflow and task have no agent key
- **When:** Preflight resolves the task
- **Then:** The configured runtime default is selected

**Scenario:** *Preflight aggregates failures*

- **Given:** Multiple task keys are missing or invalid
- **When:** Preflight validates the workflow
- **Then:** The failure contains all independent issues and no session is created

**Scenario:** *Live availability fails*

- **Given:** Static configuration is valid but the gateway cannot provide a required model
- **When:** Live preflight runs
- **Then:** Preflight fails before session creation

## Source

- [adr.runtime-resolved-execution-profiles](../adrs/2026-09-02-runtime-resolved-execution-profiles.md)
- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)

## Traceability

- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)
