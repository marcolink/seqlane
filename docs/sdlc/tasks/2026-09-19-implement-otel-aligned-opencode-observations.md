---
id: task.implement-otel-aligned-opencode-observations
title: Implement OTel-Aligned OpenCode Observations
status: in-progress
owners:
  - core
created: 2026-09-19
updated: 2026-09-20
upstream:
  - spec.otel-aligned-observation-contract
supersedes: []
---

# Implement OTel-Aligned OpenCode Observations

## Objective

Implement the draft observation contract through the real OpenCode execution
path, with the CLI/TUI as the first consumer. A single validated OpenCode
observation must become one canonical, serialized protocol event before the
CLI/TUI projects it. Mastra remains a later projection after the CLI path is
proven.

## Upstream requirements

- [spec.otel-aligned-observation-contract](../specs/2026-09-19-otel-aligned-observation-contract.md)
- [rfc.high-fidelity-local-observability](../rfcs/2026-09-19-high-fidelity-local-observability.md)
- [spec.agent-adapter-boundary-and-capabilities](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)

## Scope

- Protocol-owned Zod observation/event contract.
- One protocol-owned adapter observation sink and one OpenCode reducer.
- Protocol event delivery, then CLI/TUI projection; Mastra projection follows
  as a later tracer.
- Preserve the existing `--json` final-result-only behavior.
- Full available local model, tool, and skill payloads.
- Compatibility, malformed-input, ordering, failure-isolation, and cost
  measurements.

## Out of scope

- Recording, replay, event files, run archives, or a new persistence API.
- ACP, Codex, or other adapter implementations in this task.
- Remote OTel export or a new exporter.
- Redaction, selection, truncation, or a security policy for the local live
  observation path.
- Changes to model behavior, retries, session semantics, or workflow authoring.

## Implementation plan

The first tracer tests the highest-risk assumption: one real OpenCode model
exchange can reach the CLI/TUI through the protocol event boundary without
payload loss.

### Tracer 1: Plain-text model exchange

- **Outcome:** The exact available request and response are visible in one
  protocol event and one TUI detail view; `--json` still prints only the final
  result.
- **Path:** OpenCode native event reducer → protocol-owned observation → runner
  event bridge → serialized protocol event → CLI/TUI projection.
- **Risk:** The existing adapter, protocol, and presentation paths may use
  different identities or silently discard model content.
- **Evidence:** Deep-equality assertions for request/response values, stable
  Work/Run/Invocation/exchange IDs in the protocol event and TUI detail model,
  unchanged final-result JSON behavior, and a focused local end-to-end test.
- **Files likely touched:** `libs/protocol/src/*`, `libs/adapter/src/index.ts`,
  `libs/opencode/src/observations.ts`, `libs/runtime/src/runner/event-bridge.ts`,
  `libs/tui/src/run-view-model.ts`.
- **Excluded:** Tool, skill, structured-output repair, and streaming edge cases.

### Checkpoint 1

Stop and inspect the emitted protocol event and TUI detail model. Do not expand
the schema if either boundary loses a value or changes identity. Do not add the
Mastra projection until this CLI-first path is verified.

### Tracer 2: Tool lifecycle and correlation

- **Outcome:** One tool call preserves exact definition, arguments, result,
  metadata, lifecycle, and parent model exchange.
- **Path:** OpenCode tool-part reducer → canonical `tool` observation →
  protocol event → Mastra tool projection and TUI activity details.
- **Risk:** Existing tool/activity and native span paths may duplicate or
  transform payloads.
- **Evidence:** One stable activity identity across started/updated/completed
  events; exact argument/result round-trip; one Mastra tool observation.
- **Files likely touched:** `libs/opencode/src/attempt-transitions.ts`,
  `libs/opencode/src/observations.ts`, `libs/opencode/src/observability.ts`,
  `libs/protocol/src/contracts.ts`, `libs/tui/src/run-activity.ts`.
- **Excluded:** Skill-specific fields and repair attempts.

### Tracer 3: Skill activity

- **Outcome:** A source-reported skill remains a skill and preserves identity,
  instructions, input, output, and metadata that OpenCode exposes.
- **Path:** OpenCode skill observation → canonical `skill` observation →
  protocol event → Mastra/TUI projections.
- **Risk:** Skill calls may currently be collapsed into ordinary tool spans or
  activity summaries.
- **Evidence:** `kind: "skill"` when reported by the source, stable parent
  correlation, exact exposed payload preservation, no invented instructions,
  and no second parser.
- **Files likely touched:** `libs/opencode/src/observations.ts`,
  `libs/opencode/src/observability.ts`, `libs/runtime/src/runtime/execution/executor.ts`,
  `libs/tui/src/run-activity.ts`.
- **Excluded:** New skill discovery or execution behavior.

### Tracer 4: Multiple exchanges and structured-output repair

- **Outcome:** Each actual model response, including every repair attempt, is a
  separate model observation under one invocation.
- **Path:** OpenCode attempt loop → canonical exchange identity and zero-based
  index (`attempts - 1`) → protocol event → Mastra/TUI projections.
- **Risk:** Terminal reconciliation may duplicate an exchange or overwrite the
  first response with the final validated response.
- **Evidence:** Ordered exchange IDs, distinct attempt indexes, exact payloads
  for each response, and one final task result independent of observations.
- **Files likely touched:** `libs/opencode/src/attempt-transitions.ts`,
  `libs/opencode/src/prompt-response.ts`, `libs/opencode/src/observability.ts`,
  `libs/opencode/src/adapter-integration.spec.ts`.
- **Excluded:** ACP/Codex retry implementations.

### Checkpoint 2

Run protocol round-trip and OpenCode integration tests together. Confirm that
Mastra projection failure does not remove or alter protocol observations.

### Tracer 5: Full payload breadth and OTel mapping

- **Outcome:** The canonical event preserves messages, context, schemas,
  parts, reasoning, tool definitions, usage, cache, cost, timing, finish
  reasons, and errors exposed by OpenCode.
- **Path:** Validated native fields → canonical nested payload → protocol
  serialization → Mastra data fields and TUI details.
- **Risk:** OTel field mapping or JSON conversion may flatten, omit, or change
  values that are not present in the first text-only tracer.
- **Evidence:** Fixture containing every supported field; deep-equality
  round-trip; contract tests for each `gen_ai.*` mapping and `seqlane.*`
  extension; no OTel SDK dependency.
- **Files likely touched:** `libs/protocol/src/model-observation.ts`,
  `libs/protocol/src/validation.ts`, `libs/protocol/src/serialization.ts`,
  `libs/opencode/src/observations.ts`, `libs/opencode/src/observations.spec.ts`.
- **Excluded:** New OTel exporter implementation.

### Tracer 6: Streaming, failure, cancellation, and malformed input

- **Outcome:** Partial observations, terminal failures, cancellation, missing
  values, non-JSON values, malformed native events, and Mastra failures are
  diagnosed without changing execution or suppressing valid protocol data.
- **Path:** OpenCode reducer/error paths → canonical lifecycle/availability
  update → protocol event → isolated projections.
- **Risk:** Error handling can cause event loss, duplicate terminal updates, or
  execution failure.
- **Evidence:** Focused regression tests for each path, including exporter
  failure isolation and ordering.
- **Files likely touched:** `libs/opencode/src/observations.ts`,
  `libs/opencode/src/observability.ts`, `libs/protocol/src/validation.ts`,
  `libs/runtime/src/runner/event-bridge.ts`, `libs/runtime/src/runner/event-bridge.spec.ts`.
- **Excluded:** Persistent recording or replay recovery.

### Checkpoint 3: Cost and readiness

Measure payload bytes, serialization time, event transport time, and local
memory for representative model, tool, and skill runs. Add chunking only if the
measurements show that existing framing cannot carry the contract. Then run the
full scoped verification and review the TUI default/detail behavior.

## Affected areas

- `libs/adapter/src/index.ts`
- `libs/runtime/src/runtime/execution/executor.ts`
- `libs/runtime/src/runtime/execution/context.ts`
- `libs/runtime/src/runtime/invocation/invocation-execution.ts`
- `libs/runtime/src/runner/profile/runtime-profile.ts`
- `libs/runtime/src/runtime/compile/compile-plan.ts`
- `libs/runtime/src/runtime/mastra/mastra-execution.ts`
- `libs/runtime/src/start-workflow-run.ts`
- `libs/runtime/src/runner/event-bridge.ts`
- `libs/runtime/src/runner/run.ts`
- `libs/opencode/src/protocol.ts`
- `libs/opencode/src/session.ts`
- `libs/opencode/src/prompt-response.ts`
- `libs/opencode/src/attempt-transitions.ts`
- `libs/opencode/src/observations.ts`
- `libs/opencode/src/observability.ts`
- `libs/opencode/src/adapter.ts`
- `libs/tui/src/run-view-model.ts`
- TUI human and CI detail renderers
- relevant package manifests and `pnpm-lock.yaml`
- `docs/sdlc/`

## Verification

Run in this order:

1. `pnpm test:mapping`
2. `pnpm exec nx run protocol:test`
3. `pnpm exec nx run adapter:test`
4. `pnpm exec nx run opencode:test`
5. `pnpm exec nx run runtime:test`
6. `pnpm exec nx run tui:test`
7. Scoped builds for `protocol`, `adapter`, `opencode`, `runtime`, and `tui`
8. `pnpm docs:index`
9. `pnpm docs:validate`
10. `pnpm docs:test`
11. `git diff --check`

The implementation must also run the repository boundary checks and confirm
that contract tests pin
`c88d504ab3d9879f8e50d3cc87e69775e11db234`, and that no OTel SDK or Mastra
type enters protocol/core declarations.

## Completion criteria

- All six tracers have evidence recorded in the implementation PR.
- The first OpenCode model exchange crosses adapter, protocol, Mastra, and TUI
  boundaries with exact available payload preservation.
- Tool and skill activities remain distinct and correlated.
- Repair attempts are separate exchanges.
- Protocol malformed-input and JSON round-trip tests pass.
- Projection, exporter, cancellation, and failure paths are isolated.
- Payload cost is measured and any transport decision is evidence-based.
- No recording/replay/event-file behavior is introduced.
- Documentation, indexes, mapping, build, test, and whitespace checks pass.

## Outcome

The first CLI tracer is implemented on the feature branch. OpenCode model
request and response observations cross the protocol event bridge and render
in the human TUI with summaries by default and full details on demand. CI
renders a model summary, and `--json` remains final-result-only. Nested child
workflow observations are forwarded. The shared Zod JSON schema validates
captured payloads; Zod JSON Schema metadata is removed before validation.

The tool, skill, streaming, failure, cancellation, malformed-input, and
payload-cost tracers remain in progress. Mastra remains a later projection.

## Delivery state

The delivered slice exists on the feature branch. It is not yet reachable from
`main`. The task is not complete.

## Traceability

- [spec.otel-aligned-observation-contract: OTel-Aligned Seqlane Observation Contract](../specs/2026-09-19-otel-aligned-observation-contract.md)
- [rfc.high-fidelity-local-observability: High-Fidelity Local Model and Agent Observability](../rfcs/2026-09-19-high-fidelity-local-observability.md)
- [task.add-mastra-observability: Add Mastra Observability](./2026-09-08-add-mastra-observability.md)
