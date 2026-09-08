---
id: task.add-mastra-observability
title: Add Mastra Observability
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Add Mastra Observability

## Objective

Use Mastra observability for runtime signals while retaining Seqlane semantic
attributes, narrow runner notifications, and typed run outcomes.

## Upstream requirements

- `REQ-OBS-001`: Preserve semantic observability.
- `REQ-OBS-002`: Migrate runner and event consumers.
- `REQ-POLICY-001`: Observe admission wait after eligibility.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Dependencies

- Depends on [task.cut-over-to-mastra-runtime](./2026-09-08-cut-over-to-mastra-runtime.md).

## Scope

- Add Mastra spans or events at private runtime boundaries.
- Attach Seqlane work, run, invocation, Plan node, task, workflow, session,
  workspace, admission, outcome, and error attributes.
- Measure wait after dependencies are ready and before admission succeeds.
- Preserve narrow runner notifications and typed outcomes.
- Add observability fixture and malformed-attribute tests.

## Out of scope

- A public Mastra event contract.
- A new event broker or persistent observability store.
- Deleting `@seqlane/events`.
- Changing CLI, Studio, recording, or replay behavior.

## Implementation plan

1. Map existing runtime signals to Seqlane semantic attributes.
2. Add private Mastra instrumentation at eligibility, admission, invocation,
   outcome, and cleanup boundaries.
3. Record admission wait with stable identities.
4. Keep runner messages narrow and serializable.
5. Add semantic, timing, failure, and redaction coverage.

## Affected areas

- `libs/seqlane-runtime/`
- `libs/seqlane-runtime/src/runner/`

## Verification

Run `pnpm test:mapping` first.

Then run:

- `pnpm exec nx run seqlane-runtime:test`
- `pnpm exec nx run seqlane-events:test`
- `pnpm exec nx run seqlane-runtime:build`
- `pnpm exec nx run seqlane-events:build`

## Completion criteria

- Mastra observability carries Seqlane semantic attributes.
- Admission wait is visible after dependencies are ready.
- Runner notifications remain narrow.
- Typed outcomes remain available to IPC and UI consumers.
- Attribute bounds, redaction, and failure behavior are tested.

## Outcome

Not started.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.cut-over-to-mastra-runtime: Cut Over to the Mastra Runtime](./2026-09-08-cut-over-to-mastra-runtime.md)
