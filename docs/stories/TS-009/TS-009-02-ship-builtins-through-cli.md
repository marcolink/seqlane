# TS-009-02 — Ship built-ins through the CLI distribution

**Status:** completed

## Use Case

**As a** Seqlane user, **I want to** run a built-in workflow from the installed
CLI, **so that** shipped capabilities work without repository-relative source
paths.

## Scope

- Add `@seqlane/builtins` as a declared CLI dependency.
- Wire Nx build ordering for the built-ins package and CLI consumers.
- Include compiled built-in artifacts in the installable package output.
- Add an end-to-end CLI test that resolves and starts a builtin workflow.
- Keep runtime selection generic and external to the workflow package.

## Out of Scope

- A new runtime profile or executor implementation.
- Provider, model, credential, or OpenCode configuration in the builtin.
- Remote distribution or independent package releases.

## Implementation Notes

The CLI resolves a builtin package export to a file URL before passing the
workflow reference through the existing runner boundary. Package consumers use
the declared exports map; the built-in package and CLI do not rely on
workspace-relative imports after build. The child runner receives a resolved
module reference and remains independent of CLI discovery code.

## Acceptance Criteria

**Scenario:** *The CLI owns the built-in dependency*
- **Given:** The CLI package manifest
- **When:** Its dependencies and Nx graph are inspected
- **Then:** `@seqlane/builtins` is declared and built before CLI
  execution tests

**Scenario:** *An installed CLI resolves a builtin*
- **Given:** A built CLI and the built-ins package artifacts
- **When:** The operator selects `builtin:example`
- **Then:** The CLI loads the workflow through package exports and starts the
  existing runner without a relative source or `dist` import

**Scenario:** *Runtime configuration stays outside the builtin*
- **Given:** A builtin CLI run
- **When:** The operator selects a runtime profile
- **Then:** The runtime is supplied through the existing generic CLI option and
  no provider or executor setting is read from workflow source

## Source

- [ADR-009 — Store and Ship Built-in Workflows as a Dedicated Package](../../ADR-009-builtin-workflow-distribution.md)
- [ADR-002 — Execute Each Seqlane Run in a Dedicated Node Process](../../ADR-002-dedicated-runner-process.md)
- [ADR-008 — Keep Workflow Authoring and Plans Executor-Neutral](../../ADR-008-executor-neutral-workflow-authoring.md)
- [TS-009 — Built-in Workflow Distribution](../../TS-009-builtin-workflow-distribution.md)
