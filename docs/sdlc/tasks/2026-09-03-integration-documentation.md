---
id: task.integration-documentation
title: Complete Local Task Integration and Documentation
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.local-mechanical-tasks
supersedes: []
---

# Complete Local Task Integration and Documentation

## Objective

As a workflow author, I can use a local Git task to supply deterministic data
to an agent task and understand the local task limits.

## Upstream requirements

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [task.effect-local-task-execution](2026-09-03-effect-local-task-execution.md)

## Scope

- End-to-end local Git inspection fixture and example.
- Event, Plan snapshot, cancellation, and compatibility regression coverage.
- Core/runtime README and root usage documentation.
- Test mapping and the full verification gate.

## Out of scope

- Public Git helper packages, Git mutation APIs, shell support, and command
  policy.

## Implementation plan

1. Add the local Git fixture and local-only example.
2. Verify local output flowing into agent work.
3. Document direct-argv, foreground, non-interactive, and no-session limits.
4. Run the full repository and SDLC verification gates.

## Affected areas

- `examples/`
- `libs/seqlane-fixtures/`
- `libs/seqlane-core/README.md`
- `libs/seqlane-runtime/README.md`
- `apps/seqlane-cli/README.md`
- `docs/sdlc/`

## Verification

- End-to-end fixture coverage proves typed Git output and no model metrics for
  local tasks.
- Plan, event, cancellation, and legacy compatibility regressions pass.
- `pnpm docs:index` and `pnpm docs:validate` pass after migration.
- Repository lint, typecheck, test, build, and format checks are run.

## Completion criteria

The local Git workflow is executable and documented, local task constraints are
visible to authors, and all canonical SDLC documents are indexed and linked.

## Outcome

The local Git fixture, examples, documentation, regression coverage, and
canonical SDLC migration were delivered in [PR #8](https://github.com/marcolink/seqlane/pull/8).

## Traceability

- [spec.local-mechanical-tasks](../specs/2026-09-03-local-mechanical-tasks.md)
- [adr.local-mechanical-tasks](../adrs/2026-09-03-local-mechanical-tasks.md)
- [task.effect-local-task-execution](2026-09-03-effect-local-task-execution.md)
- [PR #8](https://github.com/marcolink/seqlane/pull/8)
