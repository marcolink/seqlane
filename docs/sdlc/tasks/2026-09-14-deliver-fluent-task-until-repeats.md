---
id: task.deliver-fluent-task-until-repeats
title: Deliver Fluent Task-Until Repeats
status: completed
owners:
  - core
created: 2026-09-14
updated: 2026-10-22
upstream:
  - spec.fluent-task-until-repeats
  - spec.workflow-execution-semantics
supersedes:
  - task.add-repeat-plan-validation
  - task.validated-repeat-postconditions
  - task.emit-render-loop-events
  - task.execute-conditioned-repeats
  - task.reject-nested-workflows-in-repeats
---

# Deliver Fluent Task-Until Repeats

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Replace the unusable `.repeat(name, options)` authoring path with one
`.task(...).until(...)` path that executes through the production runtime. Support a task or child workflow as the repeated attempt.

## Upstream requirements

- [requirement-single-fluent-loop](../specs/2026-09-14-fluent-task-until-repeats.md#requirement-single-fluent-loop)
- [requirement-typed-loop-data](../specs/2026-09-14-fluent-task-until-repeats.md#requirement-typed-loop-data)
- [requirement-bounded-execution](../specs/2026-09-14-fluent-task-until-repeats.md#requirement-bounded-execution)
- [requirement-effect-execution](../specs/2026-09-14-fluent-task-until-repeats.md#requirement-effect-execution)
- `SEQ-PR99-003`: Make nested workflow attempts supported and validated
  before execution. This replaces the cancelled rejection approach.

## Scope

- Prove postcondition timing, distinct input/result schemas, nested workflow
  attempts, finite limits, and cancellation through runtime integration tests.
- Add typed `.until()` chaining after `.task()` for both task and child
  workflow runnables. Keep a single public Flow API and remove `.repeat()` and
  its repeat-body mini-DSL.
- Normalize the initial input, attempt result, boolean condition, optional
  next-input binding, limit, and runnable reference into validated,
  serializable Plan data. Let `nextInput` read earlier Flow tasks, or omit it
  to reuse the initial input. Reject invalid scopes and limits before execution.
- Lower the repeat through private runtime loop control flow. Preserve one
  inspectable invocation per attempt and nested task, current session and
  workspace admission, cancellation, typed outcomes, and observability.
- Preserve initial input, each validated attempt result, and optional next input.
  Keep per-node and run-wide attempt budgets independent of payload size.
- Enforce the per-node and run-wide 1,000-attempt limits. Normalize exhaustion
  to the existing typed Seqlane errors.
- Replace old repeat examples and fixtures. Update public authoring and
  runtime documentation, including the active workflow contract.

## Out of scope

- General conditionals, `foreach`, retries after task failure, unbounded
  loops, parallel iterations, and persistent Seqlane loop state.
- Changing workspace policy values or implementing unrelated child-workflow
  lifecycle optimization.
- General nested-workflow workspace-admission hardening; that work remains in
  `task.nested-workflow-workspace-admission` and is not a prerequisite.
- Retrospectively changing completed historical repeat-task records.

## Implementation plan

1. Prove postcondition execution with distinct input and result schemas,
   a child workflow attempt, and an iteration bound.
2. Implement and typecheck the public Flow chain and Plan schema. Remove the
   old public repeat path in the same change.
3. Add the private runtime lowering and integrate iteration admission,
   cancellation, identity, validation, and normalized errors.
4. Update examples, documentation, and the active contract. Verify CLI and
   operational-host execution against the same built workflow.

## Affected areas

- `libs/core` Flow types, builder, Plan schemas, and tests.
- `libs/runtime` compiler, invocation/admission integration, and tests.
- `libs/fixtures`, workflow examples, and nearby authoring documentation.

## Verification

Run `pnpm test:mapping` before focused tests. Typecheck valid and invalid Flow
chains, then run core Plan-validation tests and real-runtime runtime tests for
first-attempt success, later success, exact-boundary success, both exhaustion
limits, distinct input/result schemas, task and child-workflow attempts,
cancellation, admission, initial-input reuse, and earlier-task references.
Include malformed Plan data, input transformation, false-like values,
and exact-boundary exhaustion.
Test the normal CLI and operational-host paths.
Check public declarations for runtime-engine types.

## Completion criteria

- `.task(...).until(...)` is the sole public repeat authoring path. Ordinary
  `.task()` remains a single invocation, and `.until()` affects only the task
  immediately before it.
- A child workflow is a valid attempt runnable. Its internal tasks execute
  through the runtime and retain inspectable identities and policy.
- The first and later attempt inputs, stop condition, and final result follow
  the active spec's typed and runtime-validated contracts.
- The production CLI and operational host run bounded repeats. Both limit
  errors, cancellation, and task failure stop later attempts correctly.
- Old repeat authoring, private execution paths, examples, and documentation
  are removed or migrated without a compatibility API.

## Outcome

The delivered implementation provides the fluent repeat contract. This task
supersedes four completed tasks that defined or implemented the earlier repeat
shape, and the cancelled plan to reject child workflows in repeats.
Their completed statuses remain historical records.
Review fixes isolate run identity, repeat budgets, and events; preserve task
output validation; admit all child workflow resources; and split repeat
compilation by concern. The original full test suite and typecheck passed.
The later fluent repeat contract owns current repeat-state semantics.

## Historical delivery state

Delivered to the default branch through [pull request
#114](https://github.com/marcolink/seqlane/pull/114). The merged quality gates
passed.

## Traceability

- [spec.fluent-task-until-repeats: Fluent Task-Until Repeats](../specs/2026-09-14-fluent-task-until-repeats.md)
- [spec.workflow-execution-semantics: Workflow Authoring and Execution Semantics](../specs/2026-10-22-workflow-execution-semantics.md)
- [task.add-repeat-plan-validation: Add RepeatNode Construction and Validation](./2026-09-02-add-repeat-plan-validation.md)
- [task.validated-repeat-postconditions: Add Validated Repeat Postconditions and Plan Checks](./2026-09-02-validated-repeat-postconditions.md)
- [task.emit-render-loop-events: Emit and Render Loop Lifecycle Events](./2026-09-02-emit-render-loop-events.md)
- [task.execute-conditioned-repeats: Execute Bounded Conditioned Repeats](./2026-09-02-execute-conditioned-repeats.md)
- [task.reject-nested-workflows-in-repeats: Reject Nested Workflows in Repeat Bodies](./2026-09-11-reject-nested-workflows-in-repeats.md)
