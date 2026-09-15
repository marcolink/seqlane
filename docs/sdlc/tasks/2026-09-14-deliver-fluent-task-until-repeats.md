---
id: task.deliver-fluent-task-until-repeats
title: Deliver Fluent Task-Until Repeats
status: in-progress
owners:
  - core
created: 2026-09-14
updated: 2026-09-15
upstream:
  - spec.fluent-task-until-repeats
  - spec.mastra-backed-seqlane-workflows
supersedes:
  - task.add-repeat-plan-validation
  - task.validated-repeat-postconditions
  - task.emit-render-loop-events
  - task.execute-conditioned-repeats
  - task.reject-nested-workflows-in-repeats
---

# Deliver Fluent Task-Until Repeats

## Objective

Replace the unusable `.repeat(name, options)` authoring path with one
`.task(...).until(...)` path that executes through the production Mastra
runtime. Support a task or child workflow as the repeated attempt.

## Upstream requirements

- [requirement-single-fluent-loop](../specs/2026-09-14-fluent-task-until-repeats.md#requirement-single-fluent-loop)
- [requirement-typed-loop-data](../specs/2026-09-14-fluent-task-until-repeats.md#requirement-typed-loop-data)
- [requirement-bounded-execution](../specs/2026-09-14-fluent-task-until-repeats.md#requirement-bounded-execution)
- [requirement-mastra-lowering](../specs/2026-09-14-fluent-task-until-repeats.md#requirement-mastra-lowering)
- `SEQ-PR99-003`: Make nested workflow attempts supported and validated
  before execution. This replaces the cancelled rejection approach.

## Scope

- Confirm the pinned Mastra version's post-condition loop, nested workflow,
  input mapping, iteration-count, and cancellation contracts with installed
  declarations and focused executable tests.
- Add typed `.until()` chaining after `.task()` for both task and child
  workflow runnables. Keep a single public Flow API and remove `.repeat()` and
  its repeat-body mini-DSL.
- Normalize the initial input, attempt result, boolean condition, optional
  next-input binding, limit, and runnable reference into validated,
  serializable Plan data. Let `nextInput` read earlier Flow tasks, or omit it
  to reuse the initial input. Reject invalid scopes and limits before execution.
- Lower the repeat through Mastra-native loop control flow. Preserve one
  inspectable invocation per attempt and nested task, current session and
  workspace admission, cancellation, typed outcomes, and observability.
- Store repeat inputs, dependency results, and latest result in Mastra-owned
  loop state. Persist only a JSON-safe bounded control envelope per attempt;
  reload that state and resume through the same attempt boundary.
- Enforce the per-node and run-wide 1,000-attempt limits. Normalize exhaustion
  to the existing typed Seqlane errors.
- Replace old repeat examples and fixtures. Update public authoring and
  runtime documentation, including the active Mastra-backed workflow spec.

## Out of scope

- General conditionals, `foreach`, retries after task failure, unbounded
  loops, parallel iterations, and persistent Seqlane loop state.
- Changing workspace policy values or implementing unrelated child-workflow
  lifecycle optimization.
- General nested-workflow workspace-admission hardening; that work remains in
  `task.nested-workflow-workspace-admission` and is not a prerequisite.
- Retrospectively changing completed historical repeat-task records.

## Implementation plan

1. Prove the native Mastra loop shape with distinct attempt input and result
   schemas, a child workflow attempt, and an iteration bound.
2. Implement and typecheck the public Flow chain and Plan schema. Remove the
   old public repeat path in the same change.
3. Add the private Mastra lowering and integrate iteration admission,
   cancellation, identity, validation, and normalized errors.
4. Update examples, documentation, and the active contract. Verify CLI and
   operational-host execution against the same built workflow.

## Affected areas

- `libs/core` Flow types, builder, Plan schemas, and tests.
- `libs/runtime` compiler, invocation/admission integration, and tests.
- `libs/fixtures`, workflow examples, and nearby authoring documentation.
- `docs/sdlc/specs/2026-09-08-mastra-backed-seqlane-workflows.md`.

## Verification

Run `pnpm test:mapping` before focused tests. Typecheck valid and invalid Flow
chains, then run core Plan-validation tests and real-Mastra runtime tests for
first-attempt success, later success, exact-boundary success, both exhaustion
limits, distinct input/result schemas, task and child-workflow attempts,
cancellation, admission, initial-input reuse, and earlier-task references.
Include JSON snapshot serialization, reload/resume, durable dependency results,
and oversized-envelope rejection.
Test the normal CLI and operational-host paths.
Check public declarations for Mastra types and source for forbidden `/ee/`
imports.

## Completion criteria

- `.task(...).until(...)` is the sole public repeat authoring path. Ordinary
  `.task()` remains a single invocation, and `.until()` affects only the task
  immediately before it.
- A child workflow is a valid attempt runnable. Its internal tasks execute
  through Mastra and retain inspectable identities and policy.
- The first and later attempt inputs, stop condition, and final result follow
  the active spec's typed and runtime-validated contracts.
- The production CLI and operational host run bounded repeats. Both limit
  errors, cancellation, and task failure stop later attempts correctly.
- Old repeat authoring, private execution paths, examples, and documentation
  are removed or migrated without a compatibility API.

## Outcome

The feature branch implements and verifies the fluent repeat contract. This
task supersedes four completed tasks that defined or implemented the earlier
repeat shape, and the cancelled plan to reject child workflows in repeats.
Their completed statuses remain historical records.
Review fixes isolate run identity, repeat budgets, and events; preserve task
output validation; admit all child workflow resources; and split repeat
compilation by concern. Mastra loop state now holds durable repeat values, and
bounded JSON-safe envelopes reference that state. The full test suite and
typecheck pass.

## Delivery state

In review. Commit `27b50d2` on `feat/fluent-task-until-repeats` and
[pull request #114](https://github.com/marcolink/seqlane/pull/114) contain the
implementation. The feature is not yet delivered on the target branch.

## Traceability

- [spec.fluent-task-until-repeats: Fluent Task-Until Repeats](../specs/2026-09-14-fluent-task-until-repeats.md)
- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.add-repeat-plan-validation: Add RepeatNode Construction and Validation](./2026-09-02-add-repeat-plan-validation.md)
- [task.validated-repeat-postconditions: Add Validated Repeat Postconditions and Plan Checks](./2026-09-02-validated-repeat-postconditions.md)
- [task.emit-render-loop-events: Emit and Render Loop Lifecycle Events](./2026-09-02-emit-render-loop-events.md)
- [task.execute-conditioned-repeats: Execute Bounded Conditioned Repeats](./2026-09-02-execute-conditioned-repeats.md)
- [task.reject-nested-workflows-in-repeats: Reject Nested Workflows in Repeat Bodies](./2026-09-11-reject-nested-workflows-in-repeats.md)
