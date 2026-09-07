---
id: task.propagate-mastra-observability-context
title: Propagate Per-Invocation Mastra Observability Context
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.mastra-native-agent-observability
supersedes: []
---

# Propagate Per-Invocation Mastra Observability Context

## Objective

Implement the private runtime-to-adapter observability contract. Preserve the
Mastra context for one workflow invocation. Pass that context to every agent
adapter request. Keep all active span state local to the invocation request.

Implementation MUST run on a feature branch based on `mastra`, never `main`.
Before this task, run `git merge-base HEAD mastra` and `git rev-parse mastra`.
The two outputs MUST match.

## Upstream requirements

Use [spec.mastra-native-agent-observability](../specs/2026-09-07-mastra-native-agent-observability.md)
as the contract. Implement R1 through R10. The runtime retains the flattened
Mastra `ExecuteFunctionParams` observability aliases in
`MastraPlanInvocationContext`. The adapter request has required
`observability: Partial<ObservabilityContext>`.

The runtime preserves both flattened aliases unchanged. It does not select a
current span, compare span IDs, diagnose alias mismatch, or convert mismatch
into a no-op. Each concrete adapter owns alias resolution and no-op behavior.
A small private helper can provide alias resolution and safe diagnostics only
when each adapter invokes it. The helper does not own span lifecycle or
executor observations.

The current workflow-step span is the only parent supplied to adapters. The
runtime does not create a workflow-step span. The runtime does not close that
span. The concrete adapter owns `AGENT_RUN` and descendant spans.

Mastra types stay inside `@seqlane/runtime`, `@seqlane/agent-adapter`, and
concrete adapters. Public core, events, Plans, workflow APIs, and runner IPC
remain Mastra-free. Existing aggregate metrics and events remain unchanged.

## Scope

- Add the private observability type and required request property in
  `libs/seqlane-agent-adapter/src/index.ts`.
- Carry observability through `MastraPlanInvocationContext` in
  `libs/seqlane-runtime/src/runtime/compile/mastra-plan-compiler.ts`.
- Collect both aliases from Mastra step execution parameters in
  `libs/seqlane-runtime/src/runtime/compile/mastra-plan-compiler.ts`.
- Carry the unchanged value through the invocation handler in
  `libs/seqlane-runtime/src/runtime/mastra/mastra-execution.ts`.
- Carry the value through task execution and `ExecutorRequest` in
  `libs/seqlane-runtime/src/runtime/execution/executor.ts` and
  `libs/seqlane-runtime/src/runtime/invocation/invocation-execution.ts`.
- Pass the value through `executeAgentAdapterRequest` in
  `libs/seqlane-runtime/src/runner/profile/runtime-profile.ts`.
- Keep `RuntimeAdapterFactoryContext` in
  `libs/seqlane-runtime/src/runner/profile/runtime-adapter.ts` limited to
  run/session configuration and cancellation. Do not cache active spans there.
- Update request factories and fixtures in runtime, OpenCode, ACP, and adapter
  tests so the required property is explicit.
- Add direct `@mastra/core` dependencies to packages that import its
  observability declarations or values. Use the pinned workspace version.
- Add private no-throw helpers only when an adapter needs alias resolution or
  safe diagnostics. Keep adapter invocation of those helpers explicit.

## Out of scope

- OpenCode event parsing, lifecycle reduction, or Mastra span projection.
- ACP stream parsing, lifecycle reduction, or Mastra span projection.
- Changes to public Seqlane contracts, Plan IR, serialized events, or runner
  messages.
- A shared executor-observation union or generic executor projector.
- Active span storage in `ExecutionContext`, factory context, sessions, or
  shared run state.
- Mastra exporter flushing, retries, shutdown, or storage policy.
- Changes to aggregate invocation metrics or consumer-agnostic events.

## Implementation plan

1. Verify that `git merge-base HEAD mastra` equals `git rev-parse mastra`.
   Stop when the values differ or the branch is `main`. Inspect the root
   manifest, lockfile, and installed
   `@mastra/core` declarations or source. Confirm the exact exports for
   `ExecuteFunctionParams`, `ObservabilityContext`, and aliases.
   Do not invent an import path. Record the verified source in the change.
2. Extend `MastraPlanInvocationContext` with the private partial context. Use
   the actual Mastra step parameter type at the compiler boundary. Preserve
   all existing input, result, abort, work, run, and invocation fields.
3. Add a context collector at the runtime boundary. Preserve both aliases
   without changing their shape. Leave current-span selection and mismatch
   policy to each adapter.
4. Add safe diagnostic support only for explicit adapter calls. The helper
   catches diagnostic sink errors and never throws. It does not disable
   instrumentation or own span state.
5. Add required `observability` to `AgentAdapterRequest` and `ExecutorRequest`.
   Update every request factory and test fixture. Do not make the property
   optional to hide missing propagation.
6. Pass the value through this exact hop: Mastra step params to
   `MastraPlanInvocationContext.observability` to
   `createMastraPlanInvocationHandler` to the per-invocation `executeTaskNode`
   option to `ExecutorRequest.observability` to
   `executeAgentAdapterRequest` to `AgentAdapterRequest.observability`.
   Keep the value tied to the current invocation. Do not read it from factory
   or execution context.
7. Add focused tests for unchanged alias preservation, the required request
   property, the exact propagation path, context identity, and per-invocation
   isolation. If this task adds a shared helper, test its alias resolution and
   no-throw diagnostic behavior. The adapter tasks test mismatch and no-op
   behavior. Add boundary tests for public declaration output and forbidden
   `/ee/` imports.
8. Run focused Nx tests and typechecks. Run docs gates and the repository test
   mapping check before commit review.

## Affected areas

Runtime and contract files:

- `libs/seqlane-agent-adapter/src/index.ts`
- `libs/seqlane-runtime/src/runtime/compile/mastra-plan-compiler.ts`
- `libs/seqlane-runtime/src/runtime/mastra/mastra-execution.ts`
- `libs/seqlane-runtime/src/runtime/execution/executor.ts`
- `libs/seqlane-runtime/src/runtime/invocation/invocation-execution.ts`
- `libs/seqlane-runtime/src/runner/profile/runtime-profile.ts`
- `libs/seqlane-runtime/src/runner/profile/runtime-adapter.ts`
- `libs/seqlane-runtime/package.json`
- `libs/seqlane-agent-adapter/package.json`

Likely cohesive test additions or updates:

- `libs/seqlane-runtime/src/runtime/compile/mastra-plan-compiler.spec.ts`
- `libs/seqlane-runtime/src/runtime/mastra/mastra-runtime.spec.ts`
- `libs/seqlane-runtime/src/runtime/invocation/invocation-execution.spec.ts`
- `libs/seqlane-runtime/src/runner/profile/runtime-profile.spec.ts`
- Existing OpenCode and ACP request fixtures that construct
  `AgentAdapterRequest` values.

Do not add Mastra imports to `libs/seqlane-core`, `libs/seqlane-events`,
workflow definitions, Plan serialization, or runner IPC. Use Community and
open-source Mastra paths only. Reject any `/ee/` import.

## Verification

Run the following from the repository root:

- `pnpm test:mapping`
- `pnpm nx test seqlane-runtime --skipNxCache`
- `pnpm nx build seqlane-runtime --skipNxCache`
- `pnpm nx build seqlane-agent-adapter --skipNxCache`
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

Inspect the installed, repository-pinned Mastra declarations or source before
choosing imports. Use a focused typecheck or executable test for any uncertain
alias or span-ID behavior. Verify the pinned `@mastra/core` version from the
manifest and lockfile. Confirm public declaration output has no Mastra types.
Confirm no `/ee/` import or enterprise-only requirement exists.

Tests must prove:

- `ExecuteFunctionParams` aliases reach the matching invocation context.
- Both aliases remain unchanged through the runtime hop.
- Each adapter owns current-span selection, mismatch policy, and no-op behavior.
- Each request has an explicit observability property.
- Factory context and shared `ExecutionContext` contain no active span.
- Context from one invocation cannot appear in another invocation.
- Any helper added by this task cannot change the execution outcome.
- Existing metrics, events, and cancellation behavior remain compatible.
- Public packages and runner IPC remain Mastra-free.

## Completion criteria

- R1 boundary ownership passes declaration and import guards.
- R2 propagation preserves aliases and passes context-isolation tests.
- R3 runtime preserves parent aliases. Each adapter owns parent selection.
- R4 runtime passes context only. Adapter reducers remain adapter-owned.
- R5 runtime does not infer or create typed executor spans.
- R6 runtime does not write native or aggregate metrics.
- R7 runtime preserves failure and cancellation context without span closure.
- R8 runtime passes no raw payload outside existing bounded paths.
- R9 any shared helper remains isolated from execution outcomes.
- R10 existing public contracts and events remain compatible.
- This foundation task implements shared propagation and boundary work.
- Adapter tasks implement adapter-owned R2, R3, R4, R5, R7, R8, and R9 behavior.
- The focused Nx commands, test mapping, docs gates, and diff check pass.
- The task is independently committable before either adapter projection task.

## Outcome

Planned. No implementation is included in this document change.

## Traceability

- [spec.mastra-native-agent-observability: Native Mastra Agent Observability Projection](../specs/2026-09-07-mastra-native-agent-observability.md)
- [adr.mastra-native-agent-observability: Project Executor Observations into Native Mastra Agent Observability](../adrs/2026-09-07-mastra-native-agent-observability.md)
- [rfc.execution-observability-and-debugging: Seqlane Execution Observability and Debugging](../rfcs/2026-09-02-execution-observability-and-debugging.md)
- [spec.executor-neutral-workflow-authoring: Executor-Neutral Workflow Authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)
