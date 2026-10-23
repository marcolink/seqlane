---
id: task.effect-v4-telemetry-and-event-pressure
title: Telemetry sinks and event pressure
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-classifier-and-deadlines
supersedes: []
---

# Telemetry sinks and event pressure

## Objective

Use a real mixed run to correlate CLI/worker/runtime/invocation/adapter spans, canonical observations, metrics, and structured logs.

## Upstream requirements

The target contract is owned by [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md). The coordination task links the full migration checklist and cross-slice gates. This task implements its bounded slice and does not redefine product requirements or the target contract.

## Scope

Implement this slice's behavior and removal boundary under the active target specification.

## Out of scope

Changes to product behavior, public authoring contracts, or wire contracts beyond the target specification's explicit requirements.

## Implementation plan

- Use a real mixed run to correlate CLI/worker/runtime/invocation/adapter spans, canonical observations, metrics, and structured logs.
- Exercise large payloads, bounded byte queues, slow IPC, exporter failure, and terminal flush.
- Connect an in-process collector first; add explicit OTLP configuration without enabling remote raw-data export by default.

## Affected areas

event bridge, runner transport, private telemetry services, adapter observation callers, and `libs/tui`.

## Verification

exact canonical payload round trips, correct parent/link IDs, complete-record eviction notices, bounded queues, and unchanged result on exporter failure.

## Completion criteria

- The scoped behavior is implemented and the verification evidence above passes.
- The replaced path is removed: remove remaining old observability context, projections, flush hooks, and dependencies.
- Record any unavailable live evidence and remaining delivery limits.

## Outcome

Implementation follows S7 commit `1d3958b`. The private telemetry services use native Effect spans, logs, metrics, queues, scopes, and deadlines. Public authoring and execution-event contracts retain Zod and their existing wire version.

A validated private W3C carrier joins the real CLI, worker, runtime, invocation, and native adapter spans. Canonical model, tool, and skill observations produce spans with their source timing, complete JSON attributes, and native parent or link identities. The compiled mixed-workflow proof executes deterministic preparation and one native OpenCode request against a local HTTP peer. It verifies one trace tree, matching invocation parents, complete observations, logs, and metrics. No paid-provider availability is inferred from this proof.

Required events use a scoped byte queue with a 16 MiB queued-and-in-flight bound. Native producers wait for capacity; callback producers fail explicitly on overflow. Admission commits the sequence before waking the drain. IPC acknowledgement has a five-second deadline. Sink failure cancels active work immediately, and terminal publication waits for accepted delivery and bounded cleanup. Tests retain frozen, primitive, null, undefined, composite, and late failure causes. Real HTTP and stdio adapter peers verify cancellation acknowledgement before terminal tool or invocation events.

The private worker snapshot is validated and byte bounded. Local retention omits complete records and counts omissions. Native per-run metrics cover durations, outcomes, waits, retries, normalized billing, payload bytes, queue pressure, and exporter failures. Labels exclude run IDs and raw payloads. ACP session usage remains complete observation data and never becomes per-call billing.

Remote export requires explicit configuration and an explicit metadata or full payload policy. No collector or remote exporter is installed by the CLI when configuration is absent. Export uses native OTLP JSON serialization and scoped HTTP, bounded batches, bounded acknowledgement bodies, and one total shutdown deadline. Export errors produce a fixed diagnostic without changing task results. Full projections preserve false, zero, empty strings, null, Unicode, arrays, and nested documents without field truncation.

The replaced adapter observability allocator is removed. Legacy compile, repeat, and validation consumers retain their context until S9 removes that execution path. Hosted tracer composition, flush hooks, and dependencies remain necessary until S10 replaces hosted execution. The unused CLI operational execution helper and its legacy event queue are S9 removal work. These remaining callers do not form an alternate telemetry implementation for the native worker.

Structural review separated canonical metrics, native observation projection, bounded collection, OTLP projection, acknowledgement parsing, and HTTP export. Queue admission, runner supervision, and adapter cleanup retain cohesive state-machine complexity after bounded review. No quality baseline or acknowledgement files changed. No zero-debt claim is made.

Final metrics checks pass. The full repository gate passes frozen installation, documentation validation, typecheck, tests across 20 projects, lint, build, formatting, Nx sync, and diff checks. All 663 runtime tests and 138 CLI unit tests pass. All 531 test mappings pass. The public documentation build and formatting checks pass. The complete compiled CLI suite passes 99 tests across eight files; its duplicate Codex parameter for the OpenCode-specific trace proof is skipped. Both telemetry tests parse the owning command-result schema and assert exact workflow outputs. No remote CI or new live-provider verification is claimed.

## Documentation impact

Classification: contract change

- PRD: no change
- RFC: no change
- SPEC: document the private validated trace carrier, explicit telemetry configuration, and acknowledgement boundary.
- TASK: record complete canonical payloads, real caller correlation, queue bounds, retention, exporter isolation, and cleanup evidence.
- ADR required: no

### Rationale

The accepted RFC already requires native telemetry, validated cross-process trace propagation, explicit remote export, and complete canonical data. Private carrier and operator configuration schemas make those requirements concrete. They must remain engine-neutral and must not enter workflow authoring or Plans. An engine change alone does not change the existing event version.

### Required work

Define private carrier and telemetry schemas before wiring callers. Keep nearby runtime, CLI, adapter, and TUI documentation aligned. Remove obsolete observation contexts and projections when their consumers have replacements. Identify any remaining hosted-only dependency and its S10 removal point before deferring it. Hosted endpoint and storage replacement stays in S10.

### Open questions

None.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit, after S7 commit `1d3958b`. Evidence is branch-local. Production Plan cutover remains S9 work. Hosted replacement and its remaining tracer dependencies remain S10 work.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-classifier-and-deadlines: prerequisite task](./2026-10-21-effect-v4-classifier-and-deadlines.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
