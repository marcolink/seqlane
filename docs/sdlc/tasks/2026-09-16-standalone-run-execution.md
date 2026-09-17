---
id: task.standalone-run-execution
title: Execute Standalone Runs Through Mastra
status: completed
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - spec.standalone-cli-runs
  - task.standalone-adapter-lifecycle
supersedes: []
---

# Execute Standalone Runs Through Mastra

## Objective

Connect prepared workflows and managed adapters to direct Mastra execution.
Preserve event/result contracts, cancellation, and resource cleanup without a
Seqlane operational server or durable state.

## Upstream requirements

- [requirement-execution-lifecycle](../specs/2026-09-16-standalone-cli-runs.md#requirement-execution-lifecycle)
- [requirement-no-persistence](../specs/2026-09-16-standalone-cli-runs.md#requirement-no-persistence)
- [requirement-output-and-errors](../specs/2026-09-16-standalone-cli-runs.md#requirement-output-and-errors)

## Dependencies

- [task.standalone-adapter-lifecycle](./2026-09-16-standalone-adapter-lifecycle.md)

## Scope

- Reuse of the direct runtime seam with in-memory state.
- Standalone orchestration independent from HTTP and catalog discovery.
- Bounded diagnostic routing that protects final JSON output.
- Cancellation, cleanup, runtime disposal, and output regression tests.
- Filesystem/listener evidence for no Seqlane persistence or server.

## Out of scope

- Hosted app/catalog redesign, persistence, and permission policy.
- Unrelated runtime or terminal refactoring.
- Earlier or later delivery steps beyond the integration seams needed here.

## Implementation plan

1. Reuse startWorkflowRun and pinned Mastra facilities; avoid a second engine.
2. Connect prepared workflows to the standalone adapter lifecycle.
3. Retain existing event consumers and authoritative result normalization.
4. Isolate incidental module/adapter output from final JSON stdout.
5. Enforce in-memory state and remove run-owned persistence/summary behavior.
6. Test lifecycle failures and absence of listeners, retained files, and leaks.

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

Implemented direct standalone execution through the existing Mastra Plan seam.
Standalone runs use in-memory runtime state, do not expose the Mastra server,
validate transformed workflow input once, and dispose the Mastra runtime and
adapter resources before the terminal event.

Agent adapters remain demand-driven. Deterministic tasks do not start an
adapter or resolve a model. Agent tasks require an authored model, preserve
session model inheritance, validate availability at demand, and surface cleanup
failures without hiding an earlier run failure.

Focused standalone tests cover deterministic sessions, lazy adapter startup,
late missing-model failure, unavailable models, model inheritance, transformed
input, and cleanup outcomes. The full repository test gate and format, docs,
typecheck, lint, build, Nx sync, and Git whitespace gates passed.

## Delivery state

Verified on `feat/standalone-cli-runs` in the commit containing this outcome.
The public command cutover remains pending. No target-branch delivery is claimed.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [Parent deliverable](./2026-09-16-deliver-standalone-cli-runs.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)

- [task.standalone-adapter-lifecycle](./2026-09-16-standalone-adapter-lifecycle.md)
