---
id: task.project-acp-v1-observations-into-mastra
title: Project ACP v1 Observations Into Native Mastra Spans
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.acp-mastra-observability-projection
  - task.propagate-mastra-observability-context
supersedes: []
---

# Project ACP v1 Observations Into Native Mastra Spans

## Objective

Project ACP v1 tool observations into native Mastra `AGENT_RUN` and
`TOOL_CALL` spans. Keep the existing ACP execution port and aggregate
callbacks unchanged. Keep one agent run across all structured-output repairs.
Emit no model span and no pseudo-model usage.

This task depends on [task.propagate-mastra-observability-context](./2026-09-08-propagate-mastra-observability-context.md).
It can start only after that shared task completes. It implements ACP v1 only
from [spec.acp-mastra-observability-projection](../specs/2026-09-07-acp-mastra-observability-projection.md).
Implementation MUST run on a feature branch based on `mastra`, never `main`.
Before this task, run `git merge-base HEAD mastra` and `git rev-parse mastra`.
The two outputs MUST match.

## Upstream requirements

Implement ACP R1 through R9 and every acceptance criterion in the upstream
spec. Use the shared R1 through R10 contract for context, parentage,
adapter-local ownership, lifecycle, redaction, and failure isolation.

The execution seam remains `AcpAgentStream` with only `fullStream` and `text`.
It is not an observability port. The pinned client is `@mastra/acp` 0.4.0.
The default ACP SDK is `@agentclientprotocol/sdk`. It is a transitive
lockfile resolution at 0.21.1 and exposes protocol version 1. The pinned
Mastra contract is
`@mastra/core` 1.64.0.

## Scope

- Keep `libs/seqlane-acp/src/contracts.ts` and `AcpAgentStream` unchanged as
  the execution seam. Do not add Mastra context or span operations there.
- Add direct `@mastra/core` 1.64.0 dependency to `libs/seqlane-acp/package.json`.
- Start the observability bridge only when the queued operation callback starts.
  Keep queue wait outside `AGENT_RUN`.
- Open one `AGENT_RUN` per admitted invocation before validation, prompt
  construction, schema conversion, or the first attempt.
- Keep one run across repair attempts. Use zero-based `attemptIndex` values.
- Use one Zod-owned ACP v1 parser. Validate each known stream chunk once.
- Add one adapter-local tool reducer that feeds `onActivity` and native spans.
- Key records by `(invocationId, attemptIndex, toolCallId)`.
- Validate external IDs and names. Normalize names with Unicode NFKC. Enforce
  the stated character, regex, per-invocation name, and record limits.
- Use external IDs only in typed `toolCallId` trace attributes. Keep them out
  of metric labels, tags, entity IDs, and span names.
- Open tool spans on the first valid call or delta. Close once on matching
  results. Silently ignore only matching duplicate results. Diagnose
  conflicting terminal results and late observations.
- Use local `Date` timestamps. Do not backdate spans.
- Emit no `MODEL_GENERATION`, provider, model, pseudo-model, or synthetic
  usage data.
- Close tools before the agent run. Use safe constant errors and bounded
  namespaced metadata for incomplete, cancelled, and failed outcomes.
- Disable native projection after the first span-operation failure. Clear
  handles. Make a bounded diagnostic through a no-throw helper.
- Keep runtime exporter, storage, sampling, flushing, and dropped-event
  behavior outside the adapter.
- Add deterministic Mastra span-sink tests and public boundary checks.

## Out of scope

- ACP protocol versions after v1.
- Changes to `AcpAgentStream`, `fullStream`, `text`, the controlled agent seam,
  queue capacity, or global disposal behavior.
- Model spans, pseudo-model attributes, synthetic zero-token metrics, or model
  usage inference.
- A generic executor observation union or shared protocol projector.
- Prompt, text, thought content, arguments, results, credentials, configured
  models, or raw errors in native telemetry.
- Changes to public core, events, Plans, workflow authoring, or runner IPC.
- Changes to aggregate `onMetrics` or activity `onActivity` semantics.
- Mastra exporter flush, retry, or shutdown logic.

## Implementation plan

1. Inspect the `mastra` baseline, manifest, lockfile, installed `@mastra/core`
   declarations or source, and official 1.64 tracing and metrics docs. Verify
   exact span types, child-span methods, typed attributes, Date timestamps,
   error and end signatures. Do not invent an import path.
2. Inspect `@mastra/acp` 0.4.0 and the resolved ACP SDK declarations or source.
   Confirm protocol version 1 and the stream chunk shapes used by the current
   adapter. Keep raw ACP types behind `@mastra/acp`.
3. Add a cohesive parser and reducer boundary in `libs/seqlane-acp/src`.
   Derive types from Zod. Validate each known chunk once. Keep the reducer as
   the only lifecycle source for native spans and `onActivity`.
4. Place the bridge after queue admission. If cancellation happens before the
   callback starts, create no agent span. Start the agent span before local
   validation and prompt construction.
5. Track attempt-local tool state with the three-part key. Enforce ID and name
   validation, NFKC normalization, regex fallback, 128-name cardinality, and
   1,024-record bounds. Do not retain raw content for correlation.
6. Implement exact transitions. Reject result-before-open through the existing
   malformed-stream path. Keep progress in one open record. Close one span for
   the first matching terminal result. Silently ignore only a duplicate
   matching terminal result. Diagnose conflicting terminal results and later
   updates with a bounded diagnostic. Never reopen a closed span.
7. Map only the typed allowlist. Set `toolType`, bounded `toolCallId`, and
   terminal `success` values. IDs never become span names. Only validated
   normalized tool names can become span names. IDs remain typed trace-only
   `toolCallId` values and never become metric dimensions or entity IDs. Use
   local dates and safe constant errors. Leave `success` unset for incomplete
   tools.
8. Implement descendant-first closure for normal attempt boundaries, repair,
   cancellation, stream failure, malformed data, interaction failure, and
   final result. Map normal or repair boundaries to a safe incomplete error
   with `success` unset. Map cancellation to a safe cancellation error with
   `success: false`. Map stream, malformed, text, and interaction failures to
   a safe constant error with `success: false`. When projection is disabled,
   best-effort end spans and clear handles. Close tools before `AGENT_RUN`.
   Keep the agent run open across repair attempts.
9. Implement native failure disablement. Catch create, update, error, and end
   failures. Best-effort close known spans. Emit at most one bounded diagnostic.
   Swallow diagnostic failures without recursion.
10. Keep aggregate callbacks separate. Add tests for callbacks, deterministic
    spans, parent IDs, lifecycle, bounds, redaction, public declarations, and
    forbidden `/ee/` imports.

## Affected areas

Current implementation files:

- `libs/seqlane-acp/src/adapter.ts`
- `libs/seqlane-acp/src/stream.ts`
- `libs/seqlane-acp/src/contracts.ts`
- `libs/seqlane-acp/src/adapter.spec.ts`
- `libs/seqlane-acp/src/adapter-integration.spec.ts`
- `libs/seqlane-acp/src/index.ts`
- `libs/seqlane-acp/package.json`

Likely cohesive additions include an ACP v1 stream schema and reducer module,
a native Mastra projection module, and bounded diagnostic or redaction helpers
under `libs/seqlane-acp/src`. Keep `adapter.ts` as orchestration. Do not
mandate a class name or move the execution seam into an observability module.

The shared task owns propagation. Consume its required request property. Do
not duplicate context collection in ACP. Do not add Mastra types to public
declarations. Use Community and open-source Mastra paths only. Do not import
or copy `/ee/` code.

## Verification

Run the following from the repository root:

- `pnpm test:mapping`
- `pnpm nx test seqlane-acp --skipNxCache`
- `pnpm nx build seqlane-acp --skipNxCache`
- `pnpm nx test seqlane-runtime --skipNxCache`
- `pnpm nx build seqlane-runtime --skipNxCache`
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm format:check`
- `pnpm exec nx sync:check`
- `pnpm docs:index`
- `pnpm docs:validate`
- `git diff --check`

Inspect pinned Mastra, `@mastra/acp`, and ACP SDK declarations or source
before selecting imports and fields. Use a focused typecheck or executable
test for uncertain span APIs, stream shapes, and closure behavior. Verify
`@mastra/core` 1.64.0 in the manifest and lockfile. Check that direct
`@mastra/acp` 0.4.0 is in the package manifest. Check that ACP SDK 0.21.1 is
only a transitive lockfile resolution. Check public declaration output for
Mastra or ACP leakage. Check
for `/ee/` imports and enterprise-only requirements.

The deterministic sink must prove:

- The execution seam remains only `fullStream` and `text`.
- ACP protocol version 1 is used.
- Queue wait is outside the agent span.
- Cancellation before queue admission creates no agent span.
- One admitted invocation creates one agent span across repairs.
- One parser and reducer feed both activity and native outputs.
- Keys include invocation, zero-based attempt, and validated external ID.
- Result-before-open follows the existing malformed-stream path.
- Progress stays in one record. Matching terminal result closes once.
- Only a duplicate matching terminal result is silently ignored. Conflicting
  terminal and later updates emit bounded diagnostics and never reopen.
- Tool IDs are bounded trace-only `toolCallId` attributes.
- Names use NFKC normalization, regex fallback, and cardinality limits.
- Tool IDs never become metric labels, span names, or entity IDs.
- Only validated normalized tool names can become span names.
- Spans use `SpanType.AGENT_RUN` and `SpanType.TOOL_CALL` with the required
  parentage and typed allowlist.
- Local Date timestamps are used. No event timestamp is fabricated.
- Text chunks, finish chunks, pseudo models, requested models, and synthetic
  zero usage create no model spans or model metrics.
- Child spans close before the agent run on every terminal path.
- Normal or repair boundaries use a safe incomplete error with success unset.
- Cancellation uses a safe cancellation error with success false.
- Stream, malformed, text, and interaction failures use a safe constant error
  with success false.
- Projection disablement best-effort ends spans and clears handles.
- Span-operation and diagnostic failures disable native projection without
  changing ACP execution or aggregate callbacks.
- Bounds, redaction, safe errors, public boundaries, and no `/ee/` imports hold.

## Completion criteria

- R1 ACP v1 execution and boundary checks pass.
- R2 admission, one-run lifecycle, repair index, and parentage tests pass.
- R3 adapter-local composition has one owner and no generic projector.
- R4 canonical Zod validation, keying, normalization, reducer transitions,
  idempotency, and bounds pass.
- R5 typed native span contract, parentage, timestamps, and closure pass.
- R6 no-model projection and callback separation pass.
- R7 native failure disablement and diagnostic isolation pass.
- R8 cancellation and observed disconnect closure pass.
- R9 redaction and bounds pass.
- Every upstream acceptance criterion has a test or boundary check.
- Pinned Mastra declarations and official docs support every selected API.
- Focused Nx tests and builds, test mapping, docs gates, and diff check pass.
- The task is independently committable after shared propagation completes.

## Outcome

Completed on `feature/mastra-agent-observability`, based on `mastra` at
`d43416f`.

- Added one post-admission `AGENT_RUN` per ACP v1 invocation and one typed
  `TOOL_CALL` span per canonical tool lifecycle across structured-output
  repair attempts.
- Added one Zod-derived stream parser and one adapter-local reducer for both
  existing activity callbacks and native span transitions.
- Added invocation-wide record, activity, input, and normalized-name bounds;
  tuple identity; duplicate suppression; and bounded conflict diagnostics.
- Follow-up review repair on PR #75: late and conflicting tool observations
  share an invocation-local diagnostic budget and one no-throw suppression
  summary after that budget is exhausted.
- Added descendant-first success, failure, incomplete, and cancellation
  closure with safe errors. Span-operation failures disable only native
  projection and preserve ACP execution.
- Kept queue wait, aggregate callbacks, prompts, content, results, requested
  model data, pseudo-model identity, and synthetic usage outside native spans.
  The private `AcpAgentStream` execution seam remains unchanged.
- Added the direct pinned `@mastra/core` 1.64.0 dependency and verified
  `@mastra/acp` 0.4.0 with ACP SDK 0.21.1 protocol version 1.

Focused ACP tests pass with 46 tests. Runtime tests pass with 318 tests. Test
mapping, the complete test suite, lint, build, Nx sync, documentation
validation, and diff checks pass. Repository-wide typecheck and format checks
retain only the pre-existing failures from the unchanged `mastra` baseline:
PR-review example type errors, plus formatting in
`apps/seqlane-cli/src/all-features-example.spec.ts` and
`libs/seqlane-runtime/src/runtime/mastra/operational-host.spec.ts`.

## Traceability

- [spec.acp-mastra-observability-projection: ACP v1-to-Mastra Observability Projection](../specs/2026-09-07-acp-mastra-observability-projection.md)
- [task.propagate-mastra-observability-context: Propagate Per-Invocation Mastra Observability Context](./2026-09-08-propagate-mastra-observability-context.md)
- [spec.mastra-native-agent-observability: Native Mastra Agent Observability Projection](../specs/2026-09-07-mastra-native-agent-observability.md)
- [adr.mastra-native-agent-observability: Project Executor Observations into Native Mastra Agent Observability](../adrs/2026-09-07-mastra-native-agent-observability.md)
- [spec.executor-neutral-workflow-authoring: Executor-Neutral Workflow Authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)
