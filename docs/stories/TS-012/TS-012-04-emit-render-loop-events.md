# TS-012-04 — Emit and Render Loop Lifecycle Events

**Status:** completed

## Use Case

**As a** Seqlane operator, **I want** loop and iteration events in output,
**so that** I can identify repeated work and its current iteration.

## Scope

- Add `"loop"` to `SeqlaneInvocationKind`.
- Add optional iteration data to task lifecycle events.
- Emit one loop invocation and dynamic child task invocations per iteration.
- Set each body task parent to its loop invocation.
- Extend output reducers and renderers for loop hierarchy and stable order.
- Add event and renderer tests.

## Out of Scope

- CLI command or request protocol changes.
- Persistent execution history, replay, or a graphical workflow view.

## Implementation Notes

The loop invocation has no iteration value. Body task iteration starts at 1.
Each body invocation has a new runtime Invocation ID. The static body Plan-node
address remains unchanged between iterations.

## Acceptance Criteria

**Scenario:** *Loop topology is observable*

- **Given:** A workflow Plan with one repeat
- **When:** The run starts
- **Then:** The event stream creates one invocation with kind `"loop"`

**Scenario:** *Body work is nested and numbered*

- **Given:** A repeat with two iterations
- **When:** A body task starts in each iteration
- **Then:** Both events name the loop parent and contain iteration 1 or 2

**Scenario:** *Renderer order is stable*

- **Given:** Interleaved loop task events
- **When:** A renderer reduces the event stream
- **Then:** Loop rows and child rows retain stable parent-child order

## Source

- [ADR-012 — Fluent Seqlane Flow DSL](../../ADR-012-fluent-seqlane-flow-dsl.md)
- [TS-012 — Fluent Flow DSL and Conditioned Repeat](../../TS-012-fluent-seqlane-flow-dsl.md)
- [TS-011 — Seqlane Execution Output Package](../../TS-011-seqlane-execution-output-package.md)
