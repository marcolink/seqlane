---
id: task.effect-local-task-execution
title: Run Local Tasks Through the Private Effect Runtime
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.local-mechanical-tasks
supersedes: []
---

# Run Local Tasks Through the Private Effect Runtime

## Objective

As a workflow author, I can run a local command inside a task and use typed
output without starting an agent session or spending model tokens.

## Upstream requirements

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [task.effect-v3-subprocess-gate](2026-09-03-effect-v3-subprocess-gate.md)
- [task.local-task-plan-validation](2026-09-03-local-task-plan-validation.md)

## Scope

- Private Effect-backed `TaskContext.exec()` implementation.
- Local task invocation path and compiler dispatch.
- Workspace admission, cancellation, output bounds, typed errors, and events.
- Exclusion from executor, model, and session resolution.

## Out of scope

- Shell strings, background processes, Git helper APIs, and a subprocess
  fallback.

## Implementation plan

1. Add bounded direct-argv subprocess execution behind the task context.
2. Dispatch local nodes through the existing invocation lifecycle.
3. Keep workspace admission until process termination.
4. Add cancellation, failure, output-limit, and no-agent-infrastructure tests.

## Affected areas

- `libs/seqlane-runtime/src/runtime/local/`
- `libs/seqlane-runtime/src/runtime/invocation/`
- `libs/seqlane-runtime/src/runtime/compile/`
- `libs/seqlane-runtime/src/runtime/workspace/`

## Verification

- Local execution tests cover direct argv, `cwd`, bounded streams, and
  non-zero exit results.
- Regression tests cover cancellation and workspace lease release order.
- Invocation events and no-agent behavior are covered.
- Targeted tests and lint pass after the subprocess output buffering fix.

## Completion criteria

Local tasks execute foreground commands with typed bounded output, preserve
workspace and cancellation semantics, emit generic events, and do not resolve
agent infrastructure.

## Outcome

The private subprocess implementation, local invocation path, cancellation and
workspace handling, typed failures, event coverage, and output buffering fix
were delivered in [PR #8](https://github.com/marcolink/seqlane/pull/8).

## Traceability

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [adr.local-mechanical-tasks](../adrs/2026-09-03-local-mechanical-tasks.md)
- [task.effect-v3-subprocess-gate](2026-09-03-effect-v3-subprocess-gate.md)
- [task.local-task-plan-validation](2026-09-03-local-task-plan-validation.md)
- [PR #8](https://github.com/marcolink/seqlane/pull/8)
