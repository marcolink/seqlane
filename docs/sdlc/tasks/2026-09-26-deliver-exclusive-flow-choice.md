---
id: task.deliver-exclusive-flow-choice
title: Deliver Exclusive Flow Choice
status: completed
owners:
  - core
created: 2026-09-26
updated: 2026-10-22
upstream:
  - spec.workflow-execution-semantics
  - adr.exclusive-flow-choice
supersedes: []
---

# Deliver Exclusive Flow Choice

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Let an authored Flow select and execute exactly one of two ordinary runnables
from a validated Boolean reference, then expose one typed result downstream.

## Upstream requirements

- [requirement-exclusive-flow-choice](../prd/2026-10-21-seqlane-runtime.md)
- [decision-exclusive-flow-choice](../adrs/2026-09-26-exclusive-flow-choice.md#decision-exclusive-flow-choice)
- [REQ-CHOICE-001](../specs/2026-10-22-workflow-execution-semantics.md#req-choice-001-route-one-runnable)

## Scope

- Add typed `.when(...).task(...).otherwise(...)` authoring with a Boolean
  reference, required false arm, a union output type, and one named result
  handle.
- Serialize a choice node with two task or child-workflow arm invocations.
  Validate condition scope, arm bindings, dependencies, identities, and
  registry entries before execution. Forward the selected runnable's already
  parsed output.
- Execute the selected arm through the ordinary invocation kernel.
  Acquire session and workspace admission only for that arm.
- Expose the choice and both arm identities in Plan snapshots, runtime events,
  CLI/TUI presentation, and trace correlation. Report the other arm as not
  selected; preserve successful downstream output resolution.
- Document authoring with one deterministic routing example.

## Out of scope

- Optional `else`, many-way choices, nested choice-specific builders, and
  arbitrary runtime predicate callbacks.
- A `defineConditionalTask` factory or a second scheduler.
- Changing classifier probability semantics; a deterministic task must apply
  any threshold before a choice reads its Boolean result.

## Implementation plan

1. **Tracer bullet:** Prove one Boolean input selects one deterministic task,
   leaves the other unstarted, and supplies its result to the Flow output
   through a runtime integration test.
2. Add typed authoring, choice Plan schema, registry resolution, and strict
   validation. Typecheck valid and invalid call sites, including different
   branch output schemas and a union workflow output. Test malformed and
   out-of-scope references.
3. Integrate task and child-workflow arms with admission, identity, failure,
   cancellation, skipped-arm reporting, and output parsing. Test both arms,
   concurrency with independent nodes, and session/workspace policy.
4. Update Plan snapshots, CLI/TUI display, public authoring docs, and one
   readable example. Verify a standalone run and protocol compatibility.

## Affected areas

- `libs/core/src/contracts.ts`, `dsl.ts`, `builder.ts`, and `plan-types.ts`.
- Runtime Plan validation, private Plan interpreter, invocation and event projection.
- `libs/protocol`, `libs/tui`, CLI, fixtures, and public authoring docs.

## Verification

Run `pnpm test:mapping` before scoped tests. Typecheck core and runtime. Run
core Plan/schema tests, a real-runtime branch test, protocol compatibility and
malformed-input tests, and focused CLI/TUI projection tests. Run public
boundary checks. Run `pnpm docs:index` and
`pnpm docs:validate` for documentation changes.

## Completion criteria

Both selections run exactly one arm, retain its ordinary invocation identity,
emit an explicit not-selected outcome for the other arm, and resolve one typed
choice output, including when the branch schemas differ. Failure and
cancellation never start the other arm as fallback. Malformed Plans fail before
work starts. Focused verification and a standalone run pass.

## Outcome

Implemented typed Flow choice, Plan validation, selected-arm execution,
selected-arm policy and output validation, event and TUI projection, and
public authoring documentation. Both routes succeeded in standalone CLI
runs. Focused tests cover downstream results, child workflows, cancellation,
concurrency, malformed conditions and references, and distinct output types.
PR #170 review hardening preserves typed arm roles and dependencies in Plan
snapshots, workflow subjects in events, selected-only session waits, terminal
events for unreached arms, and complete selected-task results in choice events.
Finding `SEQ-PR170-011` preserves cancellation while a selected task waits for
its session source. Runtime regression tests cover reuse and session
forking, cancelled arm and choice events, no task start or fallback, and zero
model calls.
Finding `SEQ-PR170-013` preserved single input preparation and rejected malformed
private integration data before either arm ran. Runnable input and output
validation remained unchanged. The later workflow contract owns current preparation.
Finding `SEQ-PR170-015` runs selected-arm output validation before storing the
result or emitting success and result events. Rejection fails the arm and
choice. Deterministic evaluator regressions cover shared and exclusive
workspace admission without holding the arm's execution workspace lock.
Finding `SEQ-PR170-016` shares node ID allocation across ordinary invocations,
choices, repeats, and validation nodes. Core regressions cover tasks and child
workflows named `choice` in both declaration orders. Runtime regressions
verify both routes and preserve the separate ordinary and choice results.
Finding `SEQ-PR170-017` emits selected-arm preflight failure without a task
start event. Runtime regressions cover unavailable models and unsupported
session capabilities, failed arm and choice events, no workspace admission,
no session creation, no fallback execution, and zero model calls.
Finding `SEQ-PR170-019` emits selected-arm input validation failure without a
start event. Runtime regressions cover task and child-workflow arms on
both routes, failed arm and choice events, no admission, no fallback execution,
and zero model calls. Ordinary input-failure events remain unchanged.

## Historical delivery state

Implementation is in PR #170. The target branch remains pending until merge.

## Traceability

- [spec.workflow-execution-semantics](../specs/2026-10-22-workflow-execution-semantics.md#req-choice-001-route-one-runnable)
- [adr.exclusive-flow-choice](../adrs/2026-09-26-exclusive-flow-choice.md)
- [prd.seqlane-runtime](../prd/2026-10-21-seqlane-runtime.md)
