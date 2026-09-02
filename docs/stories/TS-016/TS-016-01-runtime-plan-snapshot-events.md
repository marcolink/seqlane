# TS-016-01 — Emit Sanitized Plan Snapshots from the Runner

**Status:** completed

## Summary

Expose the complete planned graph before execution creates invocation state.

## Use Case

**As a** workflow observer, **I want to** receive the validated Plan topology
before task execution, **so that** I can see uninstantiated nodes and diagnose
runs that fail before invocation creation.

## Acceptance Criteria

**Scenario:** *A real run emits its complete static graph*

- **Given:** The runner loads, validates, and compiles a Plan
- **When:** The run starts
- **Then:** One sanitized `run.plan` event contains top-level and nested
  repeat-body nodes before any `invocation.created` event

**Scenario:** *Static and runtime identities remain distinct*

- **Given:** A Plan node later creates one or more invocations
- **When:** Consumers receive the Plan and invocation events
- **Then:** static edges use `planNodeId` and runtime edges use invocation IDs

**Scenario:** *A failed load does not fabricate a Plan*

- **Given:** Workflow loading or compilation fails
- **When:** The runner reports the failure
- **Then:** No `run.plan` event is emitted and the run is marked incomplete by
  downstream projections

## Technical Details

Build `SeqlanePlanSnapshot` from the actual compiled Plan and project it into
the canonical `run.plan` event. Include stable node IDs, kind, label or task
identity, static dependencies, repeat containment, sibling order, and bounded
iteration metadata. Exclude bindings, literals, schemas, callbacks, prompts,
credentials, executor data, and raw transcripts. Add canonical metadata at the
runner bridge and preserve existing invocation ordering after `run.plan`.

Dependencies: TS-016-00. Likely files: `libs/seqlane-runtime/src/runner/**`,
runner bridge/protocol tests, and Plan snapshot helpers. Verify with compiled
Plan, nested-repeat, ordering, redaction, and pre-compilation-failure tests.
Until TS-016-02 migrates CLI fanout, legacy runner supervision validates and
ignores `run.plan` so existing output and exit-status behavior remains stable.

## Out of Scope

- CLI fanout and consumer failure isolation
- Studio graph rendering
- Recording format or replay controls
- Workflow execution changes

## Source

- [ADR-016](../../ADR-016-consumer-agnostic-seqlane-execution-events.md)
- [TS-016](../../TS-016-consumer-agnostic-seqlane-execution-events.md)
- [TS-003](../../TS-003-seqlane-plan-ir-typed-dataflow.md)
