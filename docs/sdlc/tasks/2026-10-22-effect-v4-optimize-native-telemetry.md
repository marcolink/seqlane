---
id: task.effect-v4-optimize-native-telemetry
title: Native telemetry export
status: completed
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-optimize-process-services
supersedes: []
---

# Native telemetry export

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

Replace exporter batching/flush/transport machinery with native OtlpExporter and HTTP services where compatible. Retain owned bounds and protocol checks that native exporters do not provide. Keep domain event mapping.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: Canonical observation -> native metrics/spans/logs -> bounded optional OTLP delivery and shutdown.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

libs/runtime/src/private/telemetry

## Verification

Prove byte caps, complete JSON observation values, metadata/full policy, partial-success/rejection handling, incomplete-span filtering, failure counts and one total shutdown deadline; exporter failures must not change workflow outcome.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

The hosted manager and CLI compose `exportTelemetryEffect` directly. The enabled
CLI path evaluates one program after Oclif instead of three nested evaluations.
The private Promise exporter facade and its redundant failure latch are removed.
Counters and the export metric registry are allocated per execution, including
when the same Effect value runs again.

Native OTLP JSON serialization and scoped HTTP retain complete JSON observations,
metadata/full policy, byte-capped batches, incomplete-span filtering, bounded
64 KiB strict UTF-8 acknowledgements, partial-rejection checks, failure counts,
and one monotonic total shutdown deadline. Optional export failure preserves the
primary run result. The pinned 4.0.5 `OtlpExporter` cannot supply those bounds: its
buffer limits items, response buffers are unbounded, failures are hidden behind
retry/disable policy, and its flusher does not join already-running exports. The
runtime README records this retained seam; no dependency was added.

A real hosted-manager regression fails the preceding implementation and passes
with inherited `TestClock.layer`. It checks the HTTP request abort immediately
after advancing 100 ms, then verifies the successful stored run outcome. The
compiled CLI telemetry tests preserve trace correlation, rejection diagnostics,
and export-failure metrics.

The first full gate exposed a pre-existing 100 ms process-startup race in the
partial-output timeout test. Its repair pulls local process context work forward
from the timing task: admission captures private native context, task execution
passes it through the public callback closure, and the process boundary uses
`runPromiseWith`. Public authoring and wire contracts contain no native context.
The internal task-context helper takes one existing request instead of nine
arguments. Tests wait for real acquisition and acknowledged stdout before
advancing the native clock. A full Plan caller proves the inherited 99+1 ms
deadline, retained output and actual process exit. OS cleanup remains real.

Verification: all ten root gates pass on Node 24.16.0, including frozen install,
documentation, 613 mappings, typechecks, all project tests, lint, all package
builds, formatting, Nx synchronization and diff checks. Focused telemetry tests
pass 32 cases; compiled CLI telemetry passes two; the repaired process/task suites
pass 18. Runtime boundary audits pass. Full logs are in
`/private/tmp/seqlane-effect-v4-gates/opt-telemetry-repaired`.

Production TypeScript changes by -5 lines; tests by +271; nearby docs by +8.
These are actual line counts, including the private context seam. Test growth
adds behavioral evidence and replaces timing assumptions; total code does not
shrink in this task. Structural diagnostics retain churn on already-touched
helpers and the renamed export function's existing size; no finding was
suppressed or baseline changed.

Documentation sync: implementation matches the active spec. The spec and public
docs stay unchanged. The runtime README, task outcome and indexes are updated.
No required drift remains.

## Delivery state

Implemented and locally verified on `feat/effect-v4-migration`. The task commit
and final exact-head CI establish feature-branch delivery. No default-branch
merge or registry publication is claimed.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-process-services](./2026-10-22-effect-v4-optimize-process-services.md)
