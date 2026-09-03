# TS-023-03 — Run Local Tasks Through Effect

**Status:** ready for implementation
**Depends on:** TS-023-00, TS-023-02

## User outcome

As a workflow author, I can run a local command inside a task and use typed
output without starting an agent session or spending model tokens.

## Scope

- Private Effect-backed `TaskContext.exec()` implementation.
- Local task invocation path and compiler dispatch.
- Workspace admission, cancellation, output bounds, typed errors, and events.
- Exclusion from executor, model, and session resolution.

## Out of scope

- Shell strings, background processes, Git helper APIs, and a Node subprocess fallback.

## Acceptance criteria

**Scenario:** *Run a local command*

- **Given:** a local task that calls `exec` with command and argv
- **When:** the task runs
- **Then:** its output schema receives the command exit code and bounded streams

**Scenario:** *Cancel a local command*

- **Given:** a local task with a long-running command
- **When:** the Run is cancelled
- **Then:** Seqlane waits for process termination before it releases the workspace lease

**Scenario:** *Run without agent infrastructure*

- **Given:** a workflow with only local tasks
- **When:** it runs
- **Then:** no executor, model, or session resolver is called

## Source

- [ADR-023](../../ADR-023-local-mechanical-tasks.md)
- [TS-023](../../TS-023-local-mechanical-tasks.md)
