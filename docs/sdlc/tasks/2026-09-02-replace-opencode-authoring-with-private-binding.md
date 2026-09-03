---
id: task.replace-opencode-authoring-with-private-binding
title: Replace OpenCode authoring with a private binding
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.executor-neutral-workflow-authoring
supersedes: []
---

# Replace OpenCode authoring with a private binding

> Migrated from implementation story `TS-008-02`.

## Use Case

**As a** Seqlane maintainer, **I want to** bind generic tasks to OpenCode only inside private runtime code, **so that** OpenCode remains an implementation detail.

## Scope

- Remove `opencode.task`, `structuredOutput`, OpenCode task types, and runner factories from `@seqlane/opencode` exports.
- Accept agent task definitions in the private OpenCode binding.
- Convert generic agent work and output schemas to private OpenCode requests.
- Keep SDK compatibility, session management, structured output, cancellation, and interaction handling inside the adapter.
- Add declared private runtime dependencies that the binding requires and synchronize the lockfile.

## Out of Scope

- Public OpenCode task factories or connection types.
- Workflow-level executor selection or adapter options.
- New OpenCode runtime modes, managed lifecycle, or a user-facing adapter configuration format.
- CLI protocol migration.

## Implementation Notes

The binding receives an agent task definition from task.resolve-executors-in-private-runner. It uses only private adapter code to produce OpenCode request metadata and structured output. If a generic schema cannot support the private structured-output conversion, the binding fails through Seqlane executor failure. The package README describes a private adapter boundary only.

## Acceptance Criteria

**Scenario:** *Workflow source imports no OpenCode package*
- **Given:** A generic workflow module
- **When:** Its imports and exported values are inspected
- **Then:** It imports only core authoring contracts and has no OpenCode task factory, connection, session, or runner-execution export

**Scenario:** *The private adapter runs agent work*
- **Given:** An agent task definition and a private OpenCode binding
- **When:** The runner resolves and executes the task
- **Then:** The adapter creates its private request from generic agent work and returns the structured result for existing Seqlane output validation

**Scenario:** *Agent task metadata reaches OpenCode*
- **Given:** A task definition
- **When:** The runner executes the task
- **Then:** The private OpenCode binding receives only agent task metadata

**Scenario:** *Adapter details stay private*
- **Given:** The OpenCode package root exports and README
- **When:** They are inspected
- **Then:** They expose no workflow-authoring API, public connection contract, or documented user configuration

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.opencode-executor-integration — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../adrs/2026-09-02-opencode-executor-integration.md)
- [adr.executor-neutral-workflow-authoring — Keep Workflow Authoring and Plans Executor-Neutral](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [spec.opencode-executor-integration — OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
- [spec.executor-neutral-workflow-authoring — Executor-Neutral Workflow Authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)

## Traceability

- [spec.executor-neutral-workflow-authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)
