# TS-012-00 — Define Fluent Flow Builder Contracts

**Status:** completed

## Use Case

**As a** Seqlane author, **I want** a typed fluent Flow builder, **so that**
named task handles make workflow wiring clear.

## Scope

- Add `createFlow` and the task-only Flow builder contracts to seqlane-core.
- Add `.task()`, `.output()`, and `.define()` builder operations.
- Make a task name a unique string-literal key in later `tasks` contexts.
- Keep task handles as typed `ValueRef` values.
- Add compile-time specifications for valid and invalid authoring.

## Out of Scope

- Plan construction from Flow declarations.
- `RepeatNode`, `.repeat()`, runtime execution, and events.
- Changes to executor selection or configuration.

## Implementation Notes

`createFlow` must return `WorkflowDefinition` only after `.output(...).define()`.
The completed builder has no `.task()` method. A widened `string`, duplicate
name, or unknown `tasks` key must fail type checking. The authoring context
contains handles only. It must not expose runtime values.

## Acceptance Criteria

**Scenario:** *A literal name creates a typed handle*

- **Given:** An author calls `.task("analysis", analysisTask, ...)`
- **When:** A later binding accesses `tasks.analysis.output`
- **Then:** TypeScript infers the exact task output type

**Scenario:** *Invalid task names fail statically*

- **Given:** An author uses a widened, duplicate, or unknown task name
- **When:** The Flow definition type-checks
- **Then:** TypeScript reports an error without a cast or manual generic

**Scenario:** *The authoring context contains no results*

- **Given:** A Flow binding callback
- **When:** The author reads its context
- **Then:** The context contains workflow input and prior output handles only

## Source

- [ADR-012 — Fluent Seqlane Flow DSL](../../ADR-012-fluent-seqlane-flow-dsl.md)
- [TS-012 — Fluent Flow DSL and Conditioned Repeat](../../TS-012-fluent-seqlane-flow-dsl.md)
- [TS-003 — Plan IR and Typed Dataflow](../../TS-003-seqlane-plan-ir-typed-dataflow.md)
