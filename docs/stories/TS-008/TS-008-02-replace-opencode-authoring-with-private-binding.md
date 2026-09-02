# TS-008-02 — Replace OpenCode authoring with a private binding

**Status:** completed

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

The binding receives an agent task definition from TS-008-01. It uses only private adapter code to produce OpenCode request metadata and structured output. If a generic schema cannot support the private structured-output conversion, the binding fails through Seqlane executor failure. The package README describes a private adapter boundary only.

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

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-004 — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../../ADR-004-opencode-executor-integration.md)
- [ADR-008 — Keep Workflow Authoring and Plans Executor-Neutral](../../ADR-008-executor-neutral-workflow-authoring.md)
- [TS-004 — OpenCode Executor Integration](../../TS-004-opencode-executor-integration.md)
- [TS-008 — Executor-Neutral Workflow Authoring](../../TS-008-executor-neutral-workflow-authoring.md)
