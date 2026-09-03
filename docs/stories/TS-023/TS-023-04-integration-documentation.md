# TS-023-04 — Complete Lifecycle Integration and Documentation

**Status:** ready for implementation
**Depends on:** TS-023-03

## User outcome

As a workflow author, I can use a local Git task to supply deterministic data to
an agent task and understand the local task limits.

## Scope

- End-to-end local Git inspection fixture and example.
- Event, Plan snapshot, cancellation, and compatibility regression coverage.
- Core/runtime README and root usage documentation.
- Test mapping and full verification gate.

## Out of scope

- Public Git helper packages, Git mutation APIs, shell support, and command policy.

## Acceptance criteria

**Scenario:** *Use Git data without an agent call*

- **Given:** a workflow that runs `git status --porcelain=v1` in a local task
- **When:** a later agent task consumes the local task output
- **Then:** the agent receives the typed Git data and the local task emits no model metrics

**Scenario:** *Document local task limits*

- **Given:** the published task authoring documentation
- **When:** an author reads the local task section
- **Then:** it states the direct-argv, foreground, non-interactive, and no-session limits

## Source

- [ADR-023](../../ADR-023-local-mechanical-tasks.md)
- [TS-023](../../TS-023-local-mechanical-tasks.md)
