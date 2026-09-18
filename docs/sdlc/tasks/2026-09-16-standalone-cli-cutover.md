---
id: task.standalone-cli-cutover
title: Switch the CLI to Standalone Runs
status: cancelled
owners:
  - core
created: 2026-09-16
updated: 2026-09-18
upstream:
  - spec.standalone-cli-runs
  - task.standalone-run-execution
supersedes: []
---

# Switch the CLI to Standalone Runs

## Cancellation

Cancelled on 2026-09-18. Do not use this task to justify or add standalone
execution cutover work to adapter CLI flag or configuration changes. Those
changes are limited to the existing run flags and adapter configuration
behavior. Any future standalone execution cutover needs a newly approved task.

## Objective

Make standalone execution the public run command. Remove obsolete run flags and
paths, migrate internal callers and documentation, and prove the complete
installed CLI contract.

## Upstream requirements

- [requirement-explicit-entrypoint](../specs/2026-09-16-standalone-cli-runs.md#requirement-explicit-entrypoint)
- [requirement-adapter-lifecycle](../specs/2026-09-16-standalone-cli-runs.md#requirement-adapter-lifecycle)
- [requirement-execution-lifecycle](../specs/2026-09-16-standalone-cli-runs.md#requirement-execution-lifecycle)
- [requirement-no-persistence](../specs/2026-09-16-standalone-cli-runs.md#requirement-no-persistence)
- [requirement-output-and-errors](../specs/2026-09-16-standalone-cli-runs.md#requirement-output-and-errors)

## Dependencies

- [task.standalone-run-execution](./2026-09-16-standalone-run-execution.md)

## Scope

- Public run flags, command lifecycle, help, and examples.
- Removal of run-only HTTP/catalog/runtime-profile/recording paths.
- Migration of hook callers, examples, scripts, and relevant tests.
- Installed CLI end-to-end verification and hosted regressions.
- Parent task and canonical delivery-state reconciliation.

## Out of scope

- Hosted app/catalog redesign, persistence, and permission policy.
- Unrelated runtime or terminal refactoring.
- Earlier or later delivery steps beyond the integration seams needed here.

## Implementation plan

1. Wire run to the completed standalone preparation and execution seams.
2. Remove obsolete flags and compatibility aliases named by the specification.
3. Remove unused run-only code while preserving hosted commands and replay.
4. Migrate internal callers, hooks, examples, and user documentation.
5. Execute the full specification verification matrix and installed CLI checks.
6. Reconcile task outcomes and record commits and remaining delivery evidence.

## Affected areas

The CLI, private runtime, and adapter modules named by the parent deliverable.
Keep edits limited to the scope above and corresponding tests/documentation.

## Verification

Run the test-mapping check before focused tests. Verify the linked requirements
through observable tests and the specification's verification matrix.
Run the repository install, typecheck, test, lint, build, format, Nx sync, and
Git whitespace gates. Preserve hosted behavior during this intermediate step.

## Completion criteria

- Linked requirements pass focused verification for this delivery step.
- Existing command behavior remains coherent until the final cutover.
- Required repository checks pass and review findings are resolved.
- Parent and child task outcomes record evidence separately from target-branch delivery.

## Outcome

Not implemented. This task is obsolete for the current adapter CLI work and
must not be resumed implicitly.

## Delivery state

Cancelled. No target-branch delivery is claimed.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [Parent deliverable](./2026-09-16-deliver-standalone-cli-runs.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)

- [task.standalone-run-execution](./2026-09-16-standalone-run-execution.md)
