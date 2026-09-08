---
id: task.project-opencode-observations-into-mastra
title: Project OpenCode Observations Into Native Mastra Spans
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.opencode-mastra-observability-projection
  - task.propagate-mastra-observability-context
supersedes: []
---

# Project OpenCode Observations Into Native Mastra Spans

## Objective

Project validated OpenCode SDK v2 observations into native Mastra spans. Keep
OpenCode execution and Seqlane callbacks authoritative. Emit one agent run per
adapter invocation. Emit one model generation per assistant message. Emit one
tool call per tool part. Keep structured-output repairs inside the same agent
run.

This task depends on [task.propagate-mastra-observability-context](./2026-09-08-propagate-mastra-observability-context.md).
It can start only after that shared task completes. It also implements
[spec.opencode-mastra-observability-projection](../specs/2026-09-08-opencode-mastra-observability-projection.md).
Implementation MUST run on a feature branch based on `mastra`, never `main`.
Before this task, run `git merge-base HEAD mastra` and `git rev-parse mastra`.
The two outputs MUST match.

## Upstream requirements

Implement OpenCode R1 through R10 and every acceptance criterion in the
upstream spec. Use the shared R1 through R10 contract for context, parentage,
ownership, typed fields, lifecycle, redaction, and failure isolation.

The pinned OpenCode SDK is `@opencode-ai/sdk` 1.18.27. The pinned Mastra
contract is `@mastra/core` 1.64.0. The current event source is the SDK v2
subscription in `libs/seqlane-opencode/src/session.ts`. The current terminal
source is `libs/seqlane-opencode/src/prompt-response.ts`. Preserve both
existing sources and their current execution roles.

## Scope

- Add direct `@mastra/core` 1.64.0 dependency to `libs/seqlane-opencode/package.json`.
- Pass required per-invocation context from the completed shared task.
- Extend the existing per-attempt subscription in
  `libs/seqlane-opencode/src/session.ts` with one validated reducer.
- Fan out each validated event to interaction detection, activity and
  background-process reporting, and native span transitions.
- Add adapter-local cohesive modules for event validation, identity and
  lifecycle state, typed span mapping, redaction, and no-throw operations.
  Use names that describe responsibility. Do not require a fragile class name.
- Open one `AGENT_RUN` for each admitted `AgentAdapter.execute` invocation.
  Open it before schema conversion, session resolution, or prompt attempts.
- Keep one run across every structured-output repair attempt.
- Key assistant spans by `(sessionID, messageID)`.
- Key tool spans by `(messageID, callID)`.
- Parent known tool spans under the matching model span. Parent unknown tool
  spans directly under the agent run.
- Reconcile `parseOpenCodePromptResponse` with reducer state. Allow one
  invocation-local fallback model span when identity coverage is incomplete.
- Map provider, model, tokens, cache, reasoning, cost, unit, and source using
  verified Mastra 1.64 fields and per-message values.
- Close leaves, model spans, and the agent run in descendant-first order.
- Isolate span creation, update, closure, diagnostic, storage, export, failure,
  and cancellation behavior from execution outcomes.
- Keep `onMetrics`, `onActivity`, interaction, and background-process callbacks
  as independent existing outputs.
- Add deterministic Mastra span-sink tests and public declaration boundary
  tests.

## Out of scope

- Changes to OpenCode session, prompt, cancellation, interaction, or structured
  output semantics.
- A second event subscription, a second event consumer, or a generic executor
  observation union.
- Treating terminal response parsing as the primary event stream.
- Changes to public core, events, Plans, workflow authoring, or runner IPC.
- Manual Mastra metric rows, raw transcripts, prompts, tool arguments, tool
  results, secrets, or unbounded error text.
- ACP implementation. ACP is a separate task.
- Mastra exporter flush, retry, or shutdown logic.

## Implementation plan

1. Inspect the `mastra` baseline, manifest, lockfile, installed `@mastra/core`
   declarations or source, and the 1.64 official tracing and metrics docs.
   Verify the exact span types, child-span method, attributes, and closure
   signatures. Do not invent an import path. Record the verified source.
2. Inspect the pinned OpenCode SDK declarations or source. Confirm event
   discriminants and fields for assistant messages, tool parts, state, times,
   provider, model, tokens, cache, reasoning, and cost.
3. Add a single adapter-local event reducer to the existing subscription path.
   Validate each event once. Filter by session. Preserve event ordering.
   Reconcile repeated identity updates without reopening terminal spans.
4. Add fan-out outputs from reducer transitions. Keep interaction detection,
   `onActivity`, background-process handling, and native spans independent.
   A malformed event emits a bounded diagnostic and does not create a span.
5. Open one agent span when a current parent exists. Keep it across repairs.
   Close it after the final result or terminal failure. Never close the parent.
6. Add model-generation state keyed by `(sessionID, messageID)`. Open on the
   first valid assistant message. Update typed lifecycle and usage fields.
   Close on valid completion or error. Give every repair message its own span.
7. Add tool-part state keyed by `(messageID, callID)`. Update one span per
   identity. Use the model parent when known and the agent parent otherwise.
   Treat OpenCode `skill` parts as `TOOL_CALL` activity.
8. Keep `parseOpenCodePromptResponse` authoritative for terminal output and
   aggregate metrics. Make it expose or feed one validated adapter-private
   terminal observation with session and message identity plus per-message
   provider, model, usage, cache, reasoning, timing, and cost values. Let the
   reducer and projector consume that observation directly. Do not reconstruct
   native fields from aggregate `SeqlaneInvocationMetrics`. Do not use
   `onMetrics` as projector input. Update a matching model span or create at
   most one bounded fallback when no safe match exists. Make repeated terminal
   signals idempotent.
9. Map only verified per-message Mastra fields. Preserve executor-reported
   cost source and verified unit. If a verified cost unit cannot be established
   for Mastra 1.64.0, omit the whole cost context and emit one bounded
   diagnostic. Never record `estimatedCost` without its unit. Omit missing
   values. Do not infer totals, model identity, cost, or usage.
10. Add descendant-first closure for success, interaction failure, transport
    failure, stream closure, cancellation, and later task failure. Preserve
    completed child spans. Make terminal signals idempotent.
11. Add common redaction and bounds before all event and terminal fields enter
    spans. Keep IDs bounded for trace correlation only. Keep them out of metric
    labels and span names.
12. Add deterministic sink tests, callback compatibility tests, malformed and
    duplicate event tests, failure-isolation tests, and declaration leak tests.

## Affected areas

Current implementation files:

- `libs/seqlane-opencode/src/adapter.ts`
- `libs/seqlane-opencode/src/session.ts`
- `libs/seqlane-opencode/src/transport.ts`
- `libs/seqlane-opencode/src/protocol.ts`
- `libs/seqlane-opencode/src/prompt-response.ts`
- `libs/seqlane-opencode/src/adapter.spec.ts`
- `libs/seqlane-opencode/src/session.spec.ts`
- `libs/seqlane-opencode/src/adapter-integration.spec.ts`
- `libs/seqlane-opencode/src/contract.spec.ts`
- `libs/seqlane-opencode/package.json`

Likely cohesive additions include an event schema and reducer module, a native
Mastra projection module, and a bounded diagnostic or redaction module under
`libs/seqlane-opencode/src`. Names must follow the single-responsibility
boundary found during implementation. Keep `session.ts` as orchestration and
keep `prompt-response.ts` as terminal response validation.

Shared context files are changed only when needed to consume the completed
shared task:

- `libs/seqlane-agent-adapter/src/index.ts`
- `libs/seqlane-runtime/src/runtime/compile/mastra-plan-compiler.ts`
- `libs/seqlane-runtime/src/runner/profile/runtime-profile.ts`

Do not duplicate shared propagation logic in OpenCode. Do not add Mastra types
to public declarations. Use Community and open-source Mastra paths only. Do
not import or copy `/ee/` code.

## Verification

Run the following from the repository root:

- `pnpm test:mapping`
- `pnpm nx test seqlane-opencode --skipNxCache`
- `pnpm nx build seqlane-opencode --skipNxCache`
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

Inspect the pinned Mastra and OpenCode declarations or source before selecting
imports and fields. Use a focused typecheck or executable test for uncertain
span APIs, event fields, and terminal behavior. Verify `@mastra/core` 1.64.0
and `@opencode-ai/sdk` 1.18.27 in the manifest and lockfile. Check generated
public declarations for Mastra leakage. Check for `/ee/` imports and
enterprise-only requirements.

The deterministic sink must prove:

- One parented `AGENT_RUN` exists per admitted invocation when tracing exists.
- No current span produces no native spans and preserves execution.
- One subscription and one reducer exist per prompt attempt.
- All reducer outputs use the same validated observations. The outputs are
  interaction handling, activity reporting, background-process handling, and
  native span projection.
- One model span exists per assistant identity, including repairs.
- One tool span exists per `(messageID, callID)` with correct parentage.
- Terminal reconciliation creates at most one fallback model span.
- Provider, model, input, output, reasoning, cache, cost, unit, and source
  fields follow verified Mastra 1.64 semantics.
- Terminal projection consumes one validated private observation from
  `parseOpenCodePromptResponse` and never consumes aggregate metrics.
- Missing values stay absent. Aggregate totals do not become per-message data.
- Cost context is absent when its verified unit is absent, with one bounded
  diagnostic.
- Normal, interaction, cancellation, transport, disconnect, and later failure
  closure is descendant-first and idempotent.
- Completed spans stay complete after later task failure.
- Mastra span, diagnostic, storage, and exporter failure does not change the
  OpenCode result or existing callbacks.
- Redaction and bounds omit sensitive or unbounded content.
- Correlation IDs stay out of metric labels and span names.
- Existing `onMetrics`, `onActivity`, and interaction behavior remains intact.
- Public declarations and runner messages remain Mastra-free.

## Completion criteria

- R1 private context and direct dependency checks pass.
- R2 one subscription and one reducer per attempt pass.
- R3 one agent-run lifecycle per invocation passes.
- R4 assistant-message generation identity and repair behavior pass.
- R5 tool-part identity and parentage pass.
- R6 terminal fallback and deduplication pass.
- R7 typed per-message usage and cost mapping pass.
- R8 aggregate metrics and activity remain separate.
- R9 cancellation, closure, disconnect, and later failure handling pass.
- R10 redaction, bounds, and no-throw isolation pass.
- Every upstream acceptance criterion is covered by a test or boundary check.
- Pinned Mastra declarations and official docs support each selected API.
- Focused Nx tests and builds, test mapping, docs gates, and diff check pass.
- The task is independently committable after the shared propagation task.

## Outcome

Completed on `feature/mastra-agent-observability`, based on `mastra` at
`d43416f`.

- Added the adapter-owned OpenCode observation schemas, single event reducer,
  and native Mastra span projector.
- Added one `AGENT_RUN` per invocation, deduplicated model spans by
  `(sessionID, messageID)`, and tool spans by `(messageID, callID)` with
  model-or-agent parentage.
- Kept terminal response parsing authoritative for structured output and
  aggregate metrics. Its private observation reconciles matching event state
  or creates at most one invocation fallback.
- Added bounded identities, payload exclusion, sanitized failure and
  cancellation closure, alias-conflict no-op behavior, and no-throw span and
  diagnostic operations.
- Review repair on PR #75: repeat-body task, validation-check, and gate
  execution now retain the active observability context. OpenCode projection
  disables after its first span-operation failure, bounds model and tool
  identities, deduplicates terminal reducer output, and caps malformed-event
  diagnostics.
- Follow-up review repair on PR #75: a dedicated per-attempt transition
  dispatcher is the shared lifecycle authority for activity and span fan-out.
  Closure failures remain retryable during projection disablement, and distinct
  provider/model attributes use a bounded invocation-local budget.
- Preserved existing interaction, activity, background-process, aggregate
  metrics, structured-output repair, session, and cancellation behavior.

Focused OpenCode tests pass with 93 tests. Test mapping, complete tests, lint,
build, Nx sync, documentation validation, and diff checks pass. The direct
`@mastra/core` 1.64.0 dependency and `@opencode-ai/sdk` 1.18.27 contract were
verified from installed declarations. Repository-wide typecheck and format
checks retain only the pre-existing failures from the unchanged `mastra`
baseline: PR-review example type errors, plus formatting in
`apps/seqlane-cli/src/all-features-example.spec.ts` and
`libs/seqlane-runtime/src/runtime/mastra/operational-host.spec.ts`.

## Traceability

- [spec.opencode-mastra-observability-projection: OpenCode-to-Mastra Observability Projection](../specs/2026-09-08-opencode-mastra-observability-projection.md)
- [task.propagate-mastra-observability-context: Propagate Per-Invocation Mastra Observability Context](./2026-09-08-propagate-mastra-observability-context.md)
- [spec.mastra-native-agent-observability: Native Mastra Agent Observability Projection](../specs/2026-09-07-mastra-native-agent-observability.md)
- [adr.mastra-native-agent-observability: Project Executor Observations into Native Mastra Agent Observability](../adrs/2026-09-07-mastra-native-agent-observability.md)
- [spec.opencode-executor-integration: OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
