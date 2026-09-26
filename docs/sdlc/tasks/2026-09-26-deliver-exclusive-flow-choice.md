---
id: task.deliver-exclusive-flow-choice
title: Deliver Exclusive Flow Choice
status: completed
owners:
  - core
created: 2026-09-26
updated: 2026-09-26
upstream:
  - spec.mastra-backed-seqlane-workflows
  - adr.exclusive-flow-choice
supersedes: []
---

# Deliver Exclusive Flow Choice

## Objective

Let an authored Flow select and execute exactly one of two ordinary runnables
from a validated Boolean reference, then expose one typed result downstream.

## Upstream requirements

- [requirement-exclusive-flow-choice](../prd/2026-09-03-seqlane-on-mastra.md#requirement-exclusive-flow-choice)
- [decision-exclusive-flow-choice](../adrs/2026-09-26-exclusive-flow-choice.md#decision-exclusive-flow-choice)
- [REQ-CHOICE-001](../specs/2026-09-08-mastra-backed-seqlane-workflows.md#req-choice-001-route-one-runnable)

## Scope

- Add typed `.when(...).task(...).otherwise(...)` authoring with a Boolean
  reference, required false arm, a union output type, and one named result
  handle.
- Serialize a choice node with two task or child-workflow arm invocations.
  Validate condition scope, arm bindings, dependencies, identities, and
  registry entries before execution. Forward the selected runnable's already
  parsed output.
- Lower the choice to pinned Community Mastra control flow. Reuse the existing
  invocation kernel and session/workspace admission only for the selected arm.
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
   through real Mastra. Verify the pinned API with installed declarations
   and a focused executable test before broadening the compiler.
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
- Runtime Plan validation, Mastra compiler, invocation and event projection.
- `libs/protocol`, `libs/tui`, CLI, fixtures, and public authoring docs.

## Verification

Run `pnpm test:mapping` before scoped tests. Typecheck core and runtime. Run
core Plan/schema tests, a real-Mastra branch test, protocol compatibility and
malformed-input tests, and focused CLI/TUI projection tests. Run public
boundary and forbidden `/ee/` checks. Run `pnpm docs:index` and
`pnpm docs:validate` for documentation changes.

## Completion criteria

Both selections run exactly one arm, retain its ordinary invocation identity,
emit an explicit not-selected outcome for the other arm, and resolve one typed
choice output, including when the branch schemas differ. Failure and
cancellation never start the other arm as fallback. Malformed Plans fail before
work starts. Focused verification and a standalone run pass on the pinned
Mastra version.

## Outcome

Implemented typed Flow choice, Plan validation, Mastra branch execution,
selected-arm policy and output validation, event and TUI projection, and
public authoring documentation. Both routes succeeded in standalone CLI
runs. Focused tests cover downstream results, child workflows, cancellation,
concurrency, malformed conditions and references, and distinct output types.

## Delivery state

Implementation is in PR #170. The target branch remains pending until merge.

## Traceability

- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md#req-choice-001-route-one-runnable)
- [adr.exclusive-flow-choice](../adrs/2026-09-26-exclusive-flow-choice.md)
- [prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md#requirement-exclusive-flow-choice)
