---
id: task.nested-workflow-compilation-lifecycle
title: Simplify Nested Workflow Compilation and Lifecycle
status: planned
owners:
  - core
created: 2026-09-11
updated: 2026-09-11
upstream:
  - task.compose-workflows-as-runnables
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Simplify Nested Workflow Compilation and Lifecycle

## Objective

Remove avoidable per-invocation work and duplicated orchestration from nested
workflow execution while keeping invocation-specific identity, request
context, cancellation, and session state isolated.

## Upstream requirements

- `SEQ-PR99-008`: Cache immutable child compilation artifacts.
- `SEQ-PR99-009`: Preserve the Flow builder’s typed contract at its
  implementation boundary.
- `SEQ-PR99-013`: Use one canonical child-run lifecycle helper.
- `REQ-RUNTIME-001`: Keep compilation private and reuse the invocation kernel.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)

## Scope

- Cache validated, lowered, and compiled child workflow artifacts when the
  referenced definition is immutable; keep identity, request context,
  cancellation, and session resolution invocation-specific.
- Replace broad `unknown` Flow builder implementation parameters and the final
  double cast with separate typed declaration helpers or one narrow
  discriminated implementation boundary.
- Extract one child-run lifecycle helper and use it from direct runtime
  execution and operational hosting.
- Add tests for cache reuse, invocation isolation, lifecycle parity, and typed
  builder behavior.

## Out of scope

- Changing nested workflow semantics or workspace admission policy.
- Exposing Mastra types through public authoring or runner contracts.
- General-purpose runtime caching unrelated to immutable child compilation.

## Implementation plan

1. Identify the immutable child compilation key and isolate invocation state.
2. Introduce the private compilation cache behind the runtime boundary.
3. Narrow Flow builder implementation types without changing its public API.
4. Consolidate child start, failure, cancellation, and cleanup handling.
5. Add focused performance, lifecycle, and compile-time regression coverage.

## Affected areas

- `libs/seqlane-core/`
- `libs/seqlane-runtime/`
- `libs/seqlane-fixtures/`

## Verification

Run `pnpm test:mapping` first. Then run focused core and runtime tests,
compile-time checks, typechecks, builds, and formatting/lint validation.

## Completion criteria

- Repeated invocations of one immutable child definition reuse compilation
  artifacts without sharing invocation state.
- Direct and operational child execution use the same lifecycle behavior.
- Public Flow typing remains unchanged and the implementation has no broad
  escape-hatch cast at the dispatcher boundary.
- Tests prove cancellation, failure, context, and session isolation per
  invocation.

## Outcome

Not delivered. This task records follow-ups for `SEQ-PR99-008`,
`SEQ-PR99-009`, and `SEQ-PR99-013`.

## Delivery state

Planned; no implementation or delivery evidence claimed.

## Traceability

- [task.compose-workflows-as-runnables: Compose Workflows as Runnables](./2026-09-08-compose-workflows-as-runnables.md)
- [spec.mastra-backed-seqlane-workflows: Mastra-Backed Seqlane Workflow Contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
