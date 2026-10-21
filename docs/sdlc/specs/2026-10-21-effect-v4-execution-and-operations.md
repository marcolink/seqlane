---
id: spec.effect-v4-execution-and-operations
title: Effect v4 Execution and Operations
status: active
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - rfc.effect-v4-migration
  - prd.seqlane-runtime
supersedes:
  - spec.mastra-backed-seqlane-workflows
  - spec.mastra-runtime-and-operational-integration
  - spec.mastra-native-agent-observability
  - spec.acp-mastra-observability-projection
  - spec.standalone-cli-runs
  - spec.opencode-mastra-observability-projection
---

# Effect v4 Execution and Operations

## Summary

This active specification defines the target execution contract for the full Effect v4 migration. It is the current runtime implementation authority. Its activation records a contract change, not migration delivery.

## Goals

Use one scoped execution program across CLI, direct callers, HTTP, and MCP.
Preserve domain behavior, public Zod contracts, and canonical observation data.
Remove all previous engine integrations from the final tracked tree.

## Non-goals

This contract adds no automatic action replay, durable resume, distributed scheduler, custom Studio, or standalone recording feature.
It does not replace Oclif, Zod, or coding-agent harnesses.

## Terminology

- **Run program:** One Effect value that owns a run and its child scopes.
- **Composition root:** The CLI, Action, or host that supplies concrete services and evaluates effects.
- **Canonical event:** One protocol-validated semantic event with stable identity and sequence.
- **Projection:** A derived terminal, inspection, tracing, logging, or metric representation.

## Preserved product contracts

This specification replaces engine ownership and private runtime integration only. The following referenced contracts remain normative for their engine-independent behavior and public or wire contracts until S12 transfers them to target-only owners:

| Contract                                                                                   | Preserved requirements                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [Workflow authoring and Plan semantics](./2026-09-08-mastra-backed-seqlane-workflows.md)   | Authoring, choice selection, repeat behavior, validation, bindings, and output semantics.  |
| [Session and checkpoint semantics](./2026-09-02-session-checkpoint-reuse-and-branching.md) | Isolated, shared, checkpoint, and fork behavior.                                           |
| [Local mechanical tasks](./2026-09-03-local-mechanical-tasks.md)                           | Deterministic tasks, argv process behavior, bounds, cancellation, and workspace ownership. |
| [Repeat semantics](./2026-09-14-fluent-task-until-repeats.md)                              | Repeat limits, stop conditions, next-input bindings, admission, and invocation identity.   |
| [Classifier tasks](./2026-09-23-classifier-tasks.md)                                       | Authoring, question/result validation, connection handling, retry policy, and outputs.     |
| [Standalone CLI runs](./2026-09-16-standalone-cli-runs.md)                                 | Entrypoints, input and output modes, cancellation, and standalone isolation.               |
| [Execution events](./2026-09-02-consumer-agnostic-seqlane-execution-events.md)             | Protocol compatibility, event meaning, and serialized contracts.                           |
| [OpenCode integration](./2026-09-02-opencode-executor-integration.md)                      | Supported native harness behavior and capability reporting.                                |

Any clause in a referenced contract that requires Mastra types, APIs, spans, services, or execution is superseded by this specification. No supported behavior is removed solely because its former implementation used Mastra.

## Requirements

### requirement-contract-ownership

`libs/core` owns authoring, Plan meaning, identity, errors, and public task contracts.
`libs/protocol` owns serialized events, runner IPC, observations, operational DTOs, and version validation.
Both packages retain canonical Zod schemas and inferred types.
Public task callbacks and task context Promise methods remain supported boundaries.
No runtime service, concrete adapter, span class, HTTP client, or host storage type enters a Plan or public wire value.

Private services can use Effect types.
Use Effect Schema only for independent private data or a delegated Zod interoperability boundary.
Preserve public schema defaults, transformations, unknown-key policy, and input/output distinctions.
Reject malformed process, file, HTTP, IPC, SDK, and recording values before use.

### requirement-run-program

All production entrypoints invoke the same run program.
One scope owns adapter leases, streams, child work, process handles, admission leases, and invocation fibers.
Register release as part of acquisition. Release partially acquired resources after startup failure.
Only composition and documented interop boundaries evaluate effects.

The existing `startWorkflowRun` identity, outcome, and cancellation facade remains supported for direct consumers.
It must delegate to the same program as the runner; it must not keep a second execution loop.
Root cleanup completes before final result publication, subject to existing finite termination bounds.
Preserve the machine-output contract for primary errors, cleanup diagnostics, and exit precedence.
Do not reclassify an external operation as terminated merely because its Effect fiber stopped.

### requirement-plan-semantics

Validate definitions, registries, bindings, cycles, sessions, workspace identities, and constraints before task execution where currently required.
Preserve lazy agent setup and model availability checks at their existing boundaries.

| Plan behavior    | Required invariant                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Dependency graph | Execute each ready invocation once; start independent ready work without an artificial level barrier             |
| Data bindings    | Resolve validated predecessor outputs and workflow input with unchanged false-like values                        |
| Concurrency      | Bound executing bodies without allowing dependency waiters to exhaust execution permits                          |
| Nested workflow  | Preserve containment, child identity, output binding, cancellation, and parent resource ownership                |
| Choice           | Execute exactly one arm; emit the unselected state; validate and admit only selected work                        |
| Repeats          | Preserve per-attempt identity, output validation order, next input, termination condition, and shared run budget |
| Validation nodes | Preserve mechanical and model validation results, evidence, failure phase, and downstream behavior               |
| Failure          | Preserve failure category, cause, partial output, dependent skip reasons, and independent-work policy            |
| Terminal state   | Emit exactly one run terminal event after accepted earlier events settle                                         |

Use Effect primitives for fibers, waiting, deadlines, and retries.
Keep only the domain interpreter and policy that Effect cannot infer from a Seqlane Plan.
Remove the old Promise dependency scheduler and engine-specific graph envelopes after caller migration.

### requirement-session-and-workspace-admission

Preserve isolated sessions, serialized shared sessions, checkpoint reuse, fork inheritance, and no session merge.
Preserve selected model settings and the existing capability preflight.
Reject missing or unsupported capabilities without substitution.

Session and workspace eligibility form one atomic admission decision.
Preserve fairness and shared/exclusive compatibility across nesting, choice, and repeats.
Cancelled waiters cannot block later work.
Unconfirmed agent or process termination keeps affected ownership quarantined until the existing contract permits release.
Do not release a workspace because an adapter connection disappeared.

### requirement-external-effects

Local execution uses an argv-based Effect process operation and Node process services.
Keep explicit cwd/environment, exit status, stdout/stderr, output bounds, deadlines, and interruption semantics.
Do not introduce a shell unless the workflow explicitly requests one.
Deterministic and validation-only tasks must make zero model calls and start zero agent services.

Prove termination of owned process trees on supported platforms.
Preserve foreign processes, verify exit, and retain uncertain-termination errors after the shutdown deadline.
Use a narrow native interop implementation only for an observed platform capability gap.

Concrete adapters own SDK transport and capability reporting.
Effect scopes own their run resources, request streams, readiness waits, cancellation, and cleanup.
SDK Promise interop must pass the interruption signal and observe late settlement.
Retain OpenCode StructuredOutput access, repair attempts, permissions, native configuration, and authentication.
Retain Codex request correlation and interaction-required errors.
Replace the ACP transport with the official SDK while preserving supported ACP v1 behavior.
Do not claim unsupported fork or checkpoint capabilities after this replacement.

Classifier calls use the private run connection and an Effect HTTP client.
Preserve paired configuration, secret removal before workflow import, questions, result parsing, attempts, and total deadline.
Do not retry agent turns, workspace mutations, or publication writes with a generic transport retry policy.

### requirement-events-and-observability

Canonical events preserve their current wire version unless an intentional field change requires a version increment.
An internal engine change alone does not change the protocol version.
Golden serialization, malformed-input, and replay fixtures must establish compatibility.

One sequencing sink owns accepted events.
Use explicit byte bounds and sink acknowledgement; an event-count limit alone does not bound memory.
Keep accepted event order and full JSON values across IPC, TUI, CI, replay, and hosted storage.
Preserve complete-record eviction and visible eviction notices in bounded TUI retention.
Do not add field selection, payload truncation, or task-level observation suppression.

Backpressure must propagate to producers that support it.
For callback-only producers, preserve the existing overflow failure and diagnostic semantics.
Never silently drop required events or report successful delivery after transport failure.
When the terminal event cannot be delivered, the CLI must fail through its supervision path.

Canonical observations retain all available model, tool, skill, request, response, usage, cost, timing, availability, and correlation fields.
Validate each observation once at its owning boundary and project the accepted value.
Runtime spans start before the corresponding operation.
Observation-derived spans preserve source timing and parent/link relationships without duplicate SDK-native spans.
Exporter failure produces a bounded diagnostic and cannot change the run outcome.
Canonical sink failure remains an execution infrastructure failure under the existing output contract.

Metrics use bounded labels such as task kind, adapter kind, outcome, and error category.
Per-run IDs and raw payloads are trace/log data, never metric labels.
No exporter is active by default for standalone execution.
Remote export requires explicit operator configuration and a separate payload policy.
Keep connection-secret and diagnostic redaction at concrete adapter boundaries.

### requirement-cli

Oclif owns command parsing, validation, help, JSON integration, and usage exits.
Effect owns command application work after parsing.
One signal owner coordinates CLI interruption and worker cancellation; avoid competing global handlers from multiple runtime helpers.

Preserve explicit file/package entrypoints, normal trusted imports, bounded input modes, output selection, `--dry`, and lazy `--adapter` setup.
Preserve human, CI, event, and final JSON contracts and exit codes `0`, `1`, and `130`, with existing Oclif precedence.
Imported logs and SDK logs cannot corrupt final JSON stdout.
SIGINT, SIGTERM, supervisor disconnect, startup failure, and second interruption retain bounded owned-resource cleanup.
Plan and replay commands retain their current behavior and Zod validation.
Remove `unstable_studio` after hosted inspection parity; update help and documentation with its replacement inspection paths.

### requirement-hosted-operations

Standalone runs use memory only and create no Seqlane listener, database, history, recording, summary, or retained cache.
Adapter-managed data and intentional workflow outputs keep their existing ownership.

Hosted runs use Effect HTTP/MCP and an explicit SQL-backed inspection service.
Define Zod DTOs for these operations before host implementation:

| Operation            | Required behavior                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Health/readiness     | Distinguish listening from initialized dependencies                                            |
| Workflow list/detail | Engine-neutral metadata, input/output descriptions, and Plan snapshot                          |
| Run start            | Allocate identities once and return a run reference without waiting for completion             |
| Run status/result    | Return authoritative lifecycle state, normalized outcome, and completeness information         |
| Run events           | Ordered events after a sequence cursor, with explicit gaps and terminal state                  |
| Run list             | Bounded pagination over hosted runs                                                            |
| Cancel               | Idempotent cancellation of the same active run                                                 |
| Trace inspection     | Return correlated run/invocation/model/tool/skill inspection data                              |
| MCP list/invoke      | Workflow tools execute the same run program with bounded admission and propagated cancellation |

Keep useful existing endpoint paths and health routes where possible.
Transfer every consumed client operation to the new DTO before removing old response parsers.
Retain loopback defaults, origin validation, deadlines, concurrency limits, and secret handling.
MCP protocol negotiation and transport behavior require explicit compatibility tests against the selected v4 API.

Persist hosted run metadata, terminal results, canonical events/observations, and correlated inspection data with a versioned schema.
Use transactions for related state and sequence updates.
Flush accepted hosted data before reporting terminal inspection complete.
Report storage failure or incomplete inspection explicitly without silently inventing history or changing a completed task result.
On restart, mark interrupted runs without rerunning their external actions.

Use a fresh database for the new schema. Do not overwrite, open as the new format, or automatically remove old history.
Document the history discontinuity and keep new history inspectable after restart.

### requirement-complete-removal

The final tracked tree and built distributions contain no old engine names, imports, dependencies, symbols, file paths, fixtures, docs, skills, or assets.
Audit manifests, lockfile package snapshots, declaration files, sourcemaps, Action bundles, release tarballs, CI, Nx, ESLint, and command help.
Remove Hono and other integration dependencies only after checking that no remaining package needs them.
Keep no runtime selector, fallback, alias, or permanently duplicated projection.

Transfer retained requirements before replacing obsolete canonical documents and legacy metadata IDs.
Validate links and indexes after removal. Rewrite migration records into target-only documentation or remove them after contract transfer.
Git history and old user databases remain outside the tracked-tree removal requirement.

## Detailed design or contracts

Private implementation modules separate Plan interpretation, invocation policy, service acquisition, external I/O, events, and presentation.
Do not create one runtime service that owns every concern.
Composition roots supply concrete adapters. `libs/runtime` keeps the `boundary:generic-runtime` dependency rule.

Retain typed domain errors at package boundaries and preserve original causes.
Map Effect typed failure, defect, and interruption to the existing domain result contract once at the run boundary.
Do not serialize Effect `Cause`, fibers, scopes, or opaque third-party state over the protocol.

## Failure and edge cases

Required cases include cancellation before import, during acquisition, during admission, during execution, and during final flush.
Cover dependency failure, nested cancellation, unselected choice input errors, exhausted repeat budgets, late SDK rejection, and uncertain external termination.
Cover malformed replay, large observations, blocked IPC, exporter outage, hosted storage loss, and process crashes.
Never claim cleanup guarantees after SIGKILL or machine loss.

## Migration

This active contract supersedes the engine-specific implementation clauses listed in its metadata. S0 records the authority transition and reconciles remaining active documents. Implementation follows S0 completion and the full verification gate.
Deliver the linked vertical slices. Remove temporary internal bridges before final release.
Preserve public/wire compatibility unless an explicit contract amendment documents and tests the change.

## Verification

Run `pnpm test:mapping` before test suites.
Use focused tests for each slice, followed by full integration, package, and release gates at cutover.
Use fake clocks for policy timing and real child processes for OS termination behavior.
Validate installed package consumption outside the checkout and inspect emitted declarations and bundles.

## Acceptance criteria

Every requirement above has observable test evidence from all affected entrypoints.
All 23 packages have a recorded migration or audit result.
The complete removal audit and package verification pass.
No previous runtime fallback remains, and no observability capability lacks a documented replacement.

## Delivery state

Active target contract. [S1](../tasks/2026-10-21-effect-v4-effect-tracer.md) verifies the Effect process boundary. [S2](../tasks/2026-10-21-effect-v4-dependency-graphs.md) verifies dependency graphs through the private CLI worker composition and direct runtime facade. S3–S12, production Plan cutover, hosted replacement, and complete removal remain pending. No full migration or remote delivery is claimed.

## Traceability

- [rfc.effect-v4-migration: Migration proposal](../rfcs/2026-10-21-effect-v4-migration.md)
- [prd.seqlane-runtime: Product requirements](../prd/2026-10-21-seqlane-runtime.md)
- [Delivery task](../tasks/2026-10-21-migrate-all-packages-to-effect-v4.md)
- [Current workflow contracts](./2026-09-08-mastra-backed-seqlane-workflows.md)
- [Standalone CLI](./2026-09-16-standalone-cli-runs.md)
- [Runner process](./2026-09-02-dedicated-runner-process.md)
- [Machine output](./2026-09-15-run-machine-output.md)
- [Terminal output](./2026-09-15-run-terminal-rendering.md)
- [Canonical observations, currently draft](./2026-09-19-otel-aligned-observation-contract.md)
- [Adapter contracts](./2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [Session model semantics](./2026-09-03-model-selection-and-session-model-semantics.md)
- [Repeat semantics](./2026-09-14-fluent-task-until-repeats.md)
- [Classifier contracts](./2026-09-23-classifier-tasks.md)
