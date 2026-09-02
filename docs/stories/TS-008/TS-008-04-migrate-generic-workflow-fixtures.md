# TS-008-04 — Migrate generic workflow fixtures

**Status:** completed

## Use Case

**As a** Seqlane maintainer, **I want to** run the Renovate fixture through private bindings, **so that** representative workflow source proves executor portability.

## Scope

- Rewrite the Renovate workflow and fake workflow with `defineTask` and generic work.
- Remove the fixture dependency on `@seqlane/opencode`.
- Remove fixture exports that create OpenCode runner execution.
- Add test-only private fake and OpenCode binding providers outside workflow source.
- Add a test-only mixed agent and operation workflow fixture.
- Preserve typed dataflow, lifecycle, structured output, interaction failure, and cancellation contract coverage.

## Out of Scope

- A new Renovate workflow behavior or task sequence.
- A real model or live OpenCode server in automated tests.
- User workflow discovery or bundle distribution.
- Documentation migration outside fixture-facing package README material.

## Implementation Notes

The generic Renovate workflow keeps the same task IDs, schemas, dependency graph, and expected output. Tests decide which private binding provider the runner uses. The source module cannot import OpenCode, define connection data, or export an executor factory. A separate test-only fixture proves that the runner can combine agent and operation work in one Plan.

## Acceptance Criteria

**Scenario:** *The fixture Plan is portable*
- **Given:** The generic Renovate workflow
- **When:** It builds a Plan
- **Then:** The Plan has the established four task nodes and dataflow edges without an executor field

**Scenario:** *The same workflow runs through two private bindings*
- **Given:** The generic Renovate workflow, a fake binding, and a private OpenCode binding
- **When:** Each runner test executes the workflow
- **Then:** Both runs preserve the typed output contract without changing workflow source

**Scenario:** *A fixture combines agent and operation work*
- **Given:** A test-only workflow with agent and operation tasks
- **When:** The runner executes its Plan with private fake bindings
- **Then:** The agent task uses the agent binding and the operation task uses the capability adapter

**Scenario:** *Workflow fixtures contain no adapter leak*
- **Given:** The workflow fixture source and package manifest
- **When:** They are inspected
- **Then:** They contain no OpenCode import, executor connection, executor factory, or adapter package dependency

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-003 — Use a Seqlane-Owned Plan IR with Typed Dataflow](../../ADR-003-seqlane-plan-ir-and-typed-dataflow.md)
- [ADR-008 — Keep Workflow Authoring and Plans Executor-Neutral](../../ADR-008-executor-neutral-workflow-authoring.md)
- [TS-008 — Executor-Neutral Workflow Authoring](../../TS-008-executor-neutral-workflow-authoring.md)
- [MVP — Reference Use Case](../../MVP.md)
