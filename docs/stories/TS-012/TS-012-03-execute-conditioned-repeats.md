# TS-012-03 — Execute Bounded Conditioned Repeats

**Status:** completed

## Use Case

**As a** Seqlane operator, **I want** a repeat body to run until its condition
is true or its limit is reached, **so that** a workflow can perform bounded
repair and verification work.

## Scope

- Lower `RepeatNode` through the private runtime boundary.
- Execute body tasks sequentially for each iteration.
- Resolve current state and the post-condition after each body execution.
- Add `LoopLimitExceededError` with `RuntimeError` category.
- Propagate existing task failures and cancellation through a repeat.
- Add focused runtime contract tests.

## Out of Scope

- Parallel iterations, repeat retries, persistence, resume, and replay.
- Loop lifecycle rendering and result-lifetime release.

## Implementation Notes

`maximumIterations` is the maximum number of body executions. The body runs
once before its condition is read. A false condition on the final allowed
iteration raises `LoopLimitExceededError`. Executor details remain private.

## Acceptance Criteria

**Scenario:** *The first iteration succeeds*

- **Given:** A repeat body returns `passed: true` on iteration 1
- **When:** The workflow runs
- **Then:** The repeat returns that state without another body execution

**Scenario:** *The final allowed iteration succeeds*

- **Given:** A repeat with `maximumIterations: 3`
- **When:** Its condition becomes true on iteration 3
- **Then:** The workflow succeeds after exactly three body executions

**Scenario:** *The limit produces a normalized failure*

- **Given:** A repeat condition remains false through its final iteration
- **When:** The workflow runs
- **Then:** The outcome contains `LoopLimitExceededError`

**Scenario:** *Cancellation stops the active repeat*

- **Given:** A body task is active
- **When:** The run cancels
- **Then:** Seqlane cancels the task and does not start another iteration

## Source

- [ADR-001 — Internal Workflow Engine](../../ADR-001-mastra-internal-workflow-engine.md)
- [ADR-012 — Fluent Seqlane Flow DSL](../../ADR-012-fluent-seqlane-flow-dsl.md)
- [TS-012 — Fluent Flow DSL and Conditioned Repeat](../../TS-012-fluent-seqlane-flow-dsl.md)
