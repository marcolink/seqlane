---
id: task.add-mastra-observability
title: Add Mastra Observability
status: in-progress
owners:
  - core
created: 2026-09-08
updated: 2026-09-09
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
- Agent-level native Mastra tracing is delivered separately: per-invocation
  context propagation and OpenCode and ACP projections are complete in PR #75.
- Complete the remaining runtime-owned semantic and admission telemetry and
  align runner and execution-event consumers.
- Use the canonical bounded telemetry projection owned by the Seqlane runtime
  boundary.
- Allowlist work, run, invocation, Plan node, task, workflow, session,
  workspace, admission, and outcome identifiers; enums; counts; booleans; and
  durations.
- Omit prompts, task inputs and outputs, credentials, tokens, secrets, headers,
  filesystem paths, arbitrary metadata, stack traces, and raw causes.
- Limit each record to 64 attributes and each string value to 256 UTF-8 bytes.
  Limit a sanitized local diagnostic to 1,024 UTF-8 bytes. Require
  non-negative safe-integer counts and finite, non-negative durations. Emit
  only sanitized error category/code.
- Measure wait after dependencies are ready and before admission succeeds.
- Preserve narrow runner notifications and typed outcomes.
- Make exporter failure independent of the execution outcome.
- Add allowlist, redaction, bounds, malformed-attribute, and exporter-failure
  tests.

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
4. Project only the allowlisted bounded attributes.
5. Keep runner messages narrow and serializable.
6. Add semantic, timing, failure, redaction, bounds, and exporter-failure
   coverage.

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

- Runtime-owned Mastra observability carries Seqlane semantic attributes.
- Admission wait is visible after dependencies are ready.
- Runner notifications remain narrow.
- Typed outcomes remain available to IPC and UI consumers.
- The projection contains no disallowed values. Each record has at most 64
  attributes, each string value has at most 256 UTF-8 bytes, and each local
  diagnostic has at most 1,024 UTF-8 bytes.
- Exporter failure produces only a bounded local diagnostic and does not change
  the execution outcome.
- Attribute bounds, redaction, malformed data, and failure behavior are tested.

## Outcome

In progress. [PR #75](https://github.com/marcolink/seqlane/pull/75) delivered native agent observability: per-invocation
Mastra context propagation, OpenCode `AGENT_RUN`, `MODEL_GENERATION`, and
`TOOL_CALL` projections, ACP v1 `AGENT_RUN` and `TOOL_CALL` projections,
bounded identities and redaction, and projection-failure isolation. The
implementation is documented in the completed [propagation](./2026-09-08-propagate-mastra-observability-context.md),
[ACP](./2026-09-08-project-acp-v1-observations-into-mastra.md), and
[OpenCode](./2026-09-08-project-opencode-observations-into-mastra.md)
projection tasks.

Runtime-level semantic and admission telemetry, including wait measured after
eligibility, plus the remaining runner and execution-event consumer alignment,
remain for this umbrella task. Agent tracing is implemented; it is not a
remaining unbuilt capability.

## Traceability

- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [adr.mastra-backed-seqlane-workflows: Center Seqlane Workflows on a Mastra-Backed Executable DSL](../adrs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [task.cut-over-to-mastra-runtime: Cut Over to the Mastra Runtime](./2026-09-08-cut-over-to-mastra-runtime.md)
