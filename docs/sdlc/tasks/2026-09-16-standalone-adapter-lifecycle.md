---
id: task.standalone-adapter-lifecycle
title: Manage Standalone Adapter Lifecycle
status: planned
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - spec.standalone-cli-runs
  - task.standalone-workflow-loading
supersedes: []
---

# Manage Standalone Adapter Lifecycle

## Objective

Prepare the operator-selected adapter without Seqlane configuration. Manage its
owned service, preserve native authentication and permissions, and enforce
workflow-owned model selection.

## Upstream requirements

- [requirement-adapter-lifecycle](../specs/2026-09-16-standalone-cli-runs.md#requirement-adapter-lifecycle)
- [requirement-model-compatibility](../specs/2026-09-16-standalone-cli-runs.md#requirement-model-compatibility)

## Dependencies

- [task.standalone-workflow-loading](./2026-09-16-standalone-workflow-loading.md)

## Scope

- Private adapter startup, readiness, ownership, connection, and cleanup.
- OpenCode no-config bootstrap and coherent supported-adapter diagnostics.
- Workflow/session model inheritance and compatibility validation.
- No adapter acquisition for deterministic work.
- Failure, cancellation, concurrency, and foreign-process survival tests.

## Out of scope

- Hosted app/catalog redesign, persistence, and permission policy.
- Unrelated runtime or terminal refactoring.
- Earlier or later delivery steps beyond the integration seams needed here.

## Implementation plan

1. Inspect pinned adapter APIs and existing service/process lifecycle helpers.
2. Implement run-scoped selection and validated private configuration.
3. Manage required services with finite startup/shutdown bounds and cancellation.
4. Preserve SDK execution, native authentication, and native permission policy.
5. Enforce declared models without executor-default fallback for standalone runs.
6. Test missing prerequisites, unsupported choices, ownership, and cleanup.

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

Not implemented. A fresh Terra implementation agent delivers this task under
orchestrator review and quality gates. Commit this task before starting its successor.

## Delivery state

Planned. No target-branch delivery is claimed.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [Parent deliverable](./2026-09-16-deliver-standalone-cli-runs.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)

- [task.standalone-workflow-loading](./2026-09-16-standalone-workflow-loading.md)
