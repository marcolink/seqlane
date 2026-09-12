---
id: task.investigate-mastra-mcp-runtime-reuse
title: Investigate Mastra Runtime Reuse for MCP Invocations
status: planned
owners:
  - core
created: 2026-09-05
updated: 2026-09-05
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Investigate Mastra Runtime Reuse for MCP Invocations

## Objective

Measure the setup cost of creating a complete Mastra runtime for each reusable
MCP invocation and decide whether Seqlane should share safe runtime
infrastructure across invocations.

This task tracks review finding `SEQ-PR24-011` from
[PR #24](https://github.com/marcolink/seqlane/pull/24).

## Upstream requirements

- [requirement-server-mcp — Server and MCP](../specs/2026-09-03-mastra-runtime-and-operational-integration.md#requirement-server-mcp)
- [requirement-storage-tracing — Storage and tracing](../specs/2026-09-03-mastra-runtime-and-operational-integration.md#requirement-storage-tracing)
- [requirement-identity-events — Identity events](../specs/2026-09-03-mastra-runtime-and-operational-integration.md#requirement-identity-events)
- [requirement-cancellation-errors — Cancellation and errors](../specs/2026-09-03-mastra-runtime-and-operational-integration.md#requirement-cancellation-errors)

## Scope

- Measure sequential and concurrent MCP invocation setup costs.
- Attribute setup cost to Mastra construction, storage, observability, exporter,
  and workflow registration.
- Inspect the pinned Mastra APIs for reusable infrastructure boundaries.
- Define the isolation rules for Work, Run, request context, cancellation,
  storage, and tracing when infrastructure is shared.
- Implement the smallest safe reuse change if measurements justify it.
- Otherwise, record the measured deferral decision and the threshold or trigger
  that should reopen this task.

## Out of scope

- Changing MCP authentication or discovery semantics.
- Changing dispatcher queue, cancellation, or deadline behavior.
- Removing per-invocation identity or one-run execution isolation.
- Introducing speculative caching or a new runtime abstraction without measured
  benefit.

## Implementation plan

1. Establish a repeatable baseline for sequential and concurrent MCP calls.
2. Profile runtime setup and steady-state execution separately.
3. Review the pinned Mastra lifecycle, storage, and observability APIs.
4. Select a reuse boundary that preserves per-invocation identity and
   cancellation isolation.
5. Implement and benchmark the selected change, or document why the baseline
   is acceptable and when to revisit it.

## Affected areas

- `libs/runtime/src/runtime/mastra/mastra-runtime.ts`
- `libs/runtime/src/runtime/mastra/mastra-server.ts`
- Mastra runtime integration tests and benchmarks
- `libs/runtime/README.md`

## Verification

- Baseline and optimized measurements use the same workflow and input mix.
- Sequential and concurrent invocation results remain unchanged.
- Work and Run identities remain unique and correctly attributed.
- Request context and cancellation do not cross invocation boundaries.
- Storage and tracing remain canonical and correctly correlated.
- The focused runtime suite, typecheck, lint, and documentation validation
  pass.

## Completion criteria

The repository contains a measured decision about Mastra runtime reuse. If an
optimization is implemented, it has focused regression coverage and a
repeatable benchmark. If the work is deferred, the task records the evidence,
revisit trigger, and reason the current setup cost is acceptable.

## Outcome

## Traceability

- [spec.mastra-runtime-and-operational-integration — Mastra Runtime and Operational Integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-server-mcp — Expose Workflows Through Mastra Server and MCP](./2026-09-03-mastra-server-mcp.md)
