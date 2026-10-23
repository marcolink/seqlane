---
id: task.effect-v4-optimize-hosted-services
title: Scoped hosted services
status: completed
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Scoped hosted services

## Objective

Remove duplicated infrastructure through the pinned Effect v4 APIs. Preserve supported behavior and observability.

## Upstream requirements

The active execution and operations spec owns all contracts. Oclif and public/wire Zod stay unchanged.

## Documentation impact

Classification: implementation-only.

- PRD, RFC, ADR and SPEC: no change; existing ownership and behavior apply.
- TASK: create this bounded follow-up after the completed migration.
- Nearby docs: update only changed private service or process descriptions.

## Scope

Replace private Promise services and nested evaluations with scoped Effect services. Use native Deferred, FiberMap and Latch for completion and owned fibers. Keep lazy listen and fetch without listening.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: HTTP/MCP -> manager -> SQLite -> inspected terminal status, with one inherited Effect context.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

libs/runtime/src/runtime/operations

## Verification

Concurrent start/shutdown, duplicate IDs, cancellation, late acquisition, incomplete history, exclusive database ownership, restart inspection, HTTP and MCP all retain their current results.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

The HTTP -> manager -> SQL -> result/events/trace tracer passes. Private store
and manager methods now return Effects. The host composes their scoped Layers
and owns Promise evaluation. The SQL connection inherits the caller context;
queries no longer create runtimes or evaluate effects. Native FiberMap,
Deferred, Latch, and cached shutdown replace manual fibers and Promise waiting.
The shared run settlement helper now also exposes an Effect for hosted callers.
`acquireInvokeReference` and `settleManagerPromise` are removed.

Existing cancellation, capacity, incomplete-history, exact-cause, recovery, and
MCP tests retain their assertions. Added regressions cover inherited Clock and
parent span, scoped database ownership, duplicate IDs, and listener/shutdown
races. No dependencies, public contracts, replay behavior, or provider calls
changed. Optional telemetry export remains a Promise edge for its separate task.

Focused verification: test mapping, all 39 hosted tests, runtime and spec
typechecks, runtime-boundary audit, focused ESLint, docs index and docs validation
pass. ESLint retains two existing non-null assertion warnings. The four touched
production files total 2,580 formatted lines, down from 2,783 (203 fewer). Store
and manager evaluation calls fall from 15 to zero; neither exposes Promise methods.
The store removes its ManagedRuntime. Host evaluation remains at its public
and HTTP composition boundaries.

Ripwire flags host and incomplete-outcome function length, a test/host exit
unwrapping clone, and recent edit churn. Its graph also reports untested seams;
these heuristic findings do not replace the focused behavioral tests. No new
quality baseline or suppression was added. All ten repository checks pass: frozen install, docs validation, test mapping,
typecheck, tests across 20 projects, lint, all builds, formatting, Nx sync and
diff checks. No supported behavior or documentation drift remains.

## Delivery state

Completed locally in this task's commit on `feat/effect-v4-migration`.
Final published-head CI belongs to the last optimization task. No default-branch
merge or registry publication is claimed.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
