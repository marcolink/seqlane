# TS-008-00 — Make core tasks and Plans executor-neutral

**Status:** completed

## Use Case

**As a** workflow author, **I want to** define generic Seqlane work and build a generic Plan, **so that** a workflow does not select its executor.

## Scope

- Replace `TaskDefinition.executor` with an agent-oriented task contract in `@seqlane/core`.
- Remove `TaskNode.executor` from the serialized Plan and Plan validation.
- Retain generic task definitions in the workflow build result by task ID.
- Update core type and runtime compatibility tests for the breaking contract.

## Out of Scope

- Private executor resolution or runtime profile loading.
- OpenCode SDK, session, request, or structured-output code.
- CLI and runner protocol changes.
- Fixture and documentation migration.

## Implementation Notes

Agent task metadata is executor-neutral text and references. It is not a provider prompt or adapter option. Plan serialization must contain no function, task metadata, schema, executor identity, or adapter state. The in-memory registry can retain the generic task definition for later private resolution.

## Acceptance Criteria

**Scenario:** *Agent authoring has no executor selector*
- **Given:** A task input schema, output schema, and generic agent work
- **When:** An author calls `defineTask` and uses the task in a workflow
- **Then:** TypeScript infers the existing task and `ValueRef` types without an executor name or adapter import

**Scenario:** *The Plan has no executor data*
- **Given:** A workflow that invokes several generic tasks
- **When:** The workflow builds and serializes a Plan
- **Then:** Each task node contains only task identity, invocation identity, input bindings, and dependencies

**Scenario:** *Task definitions remain in memory*
- **Given:** A built workflow with repeated task invocations
- **When:** The runner inspects the build result
- **Then:** It can look up the one generic task definition by task ID, while the Plan contains no work data or executor binding

## Source

- [RFC-001 — Seqlane Technical Architecture](../../RFC-001-seqlane-technical-architecture.md)
- [ADR-003 — Use a Seqlane-Owned Plan IR with Typed Dataflow](../../ADR-003-seqlane-plan-ir-and-typed-dataflow.md)
- [ADR-008 — Keep Workflow Authoring and Plans Executor-Neutral](../../ADR-008-executor-neutral-workflow-authoring.md)
- [TS-008 — Executor-Neutral Workflow Authoring](../../TS-008-executor-neutral-workflow-authoring.md)
