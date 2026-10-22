---
id: spec.effect-v4-execution-and-operations
title: Effect v4 Execution and Operations
status: active
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - rfc.effect-v4-migration
  - prd.seqlane-runtime
supersedes:
  - spec.standalone-cli-runs
  - spec.effect-runtime-integration
  - spec.dedicated-runner-process
  - spec.local-read-only-execution-studio
  - spec.local-development-studio-trust-and-lifecycle
  - spec.studio-vite-development-and-isolated-replay
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

This specification replaces engine ownership and private runtime integration only. The following current owners are normative for domain behavior and public or wire contracts:

| Contract                                                                                   | Preserved requirements                                                                         |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [Workflow authoring and Plan semantics](./2026-10-22-workflow-execution-semantics.md)      | Authoring, choice selection, repeat behavior, validation, bindings, and output semantics.      |
| [Adapter observations](./2026-10-22-adapter-observation-projection.md)                     | Source extraction, one reducer, identity, lifecycle, deduplication, and truthful availability. |
| [Session and checkpoint semantics](./2026-09-02-session-checkpoint-reuse-and-branching.md) | Isolated, shared, checkpoint, and fork behavior.                                               |
| [Local mechanical tasks](./2026-09-03-local-mechanical-tasks.md)                           | Deterministic tasks, argv process behavior, bounds, cancellation, and workspace ownership.     |
| [Repeat semantics](./2026-09-14-fluent-task-until-repeats.md)                              | Repeat limits, stop conditions, next-input bindings, admission, and invocation identity.       |
| [Classifier tasks](./2026-09-23-classifier-tasks.md)                                       | Authoring, question/result validation, connection handling, retry policy, and outputs.         |
| [Standalone CLI runs](./2026-09-16-standalone-cli-runs.md)                                 | Entrypoints, input and output modes, cancellation, and standalone isolation.                   |
| [Execution events](./2026-09-02-consumer-agnostic-seqlane-execution-events.md)             | Protocol compatibility, event meaning, and serialized contracts.                               |
| [OpenCode integration](./2026-09-02-opencode-executor-integration.md)                      | Supported native harness behavior and capability reporting.                                    |

This specification owns Effect execution mechanisms. Focused contracts own domain semantics; no supported behavior disappears because its private implementation changed.

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
Select an explicitly configured ACP model from the agent's advertised model configuration options.
If the selected SDK cannot represent an agent's model-selection extension, fail before prompting instead of choosing another model.
Retain native ACP context-usage updates as `acp.session.usage` observations with complete `model.usage` values.
Keep the complete session notification, including its `sessionId`, `update`, and optional `_meta`, inside `model.usage`.
Context occupancy and window size are not billed input or output tokens.
Cumulative session cost, including its currency, stays inside the native usage value and is not counted as per-call cost.
Mark unavailable underlying model identity and per-call usage truthfully.

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

The private worker startup carrier is a validated JSON object with W3C
`traceparent` and optional `tracestate` fields. The CLI captures and removes
`SEQLANE_TRACE_CARRIER` before authored workflow imports. It carries trace
context only; Work, Run, and Invocation identities remain canonical Seqlane
fields.
The worker creates a native run span beneath this parent and adds its carrier
to accepted canonical event metadata. The CLI owns the real parent span.
`SEQLANE_TELEMETRY` is optional strict-Zod configuration. It requires an
HTTP(S) endpoint and an explicit `payloadPolicy` (`metadata` or `full`), with
bounded headers, pending bytes, and shutdown time. The CLI captures and removes
this variable before authored workflow imports. No exporter exists when the
variable is absent. Export uses complete OTLP JSON records in acknowledged
byte-bounded batches. An oversized record is omitted whole and counted in a
bounded diagnostic. Export errors cannot change a task result.
The private worker snapshot carries validated queue capacity, peak pending
bytes, capacity-wait count, and overflow count. The CLI records these values
in the run's native metric registry. Export failures use a bounded signal label.
A healthy metrics endpoint can report failures of other signals. Failure of
the metrics endpoint itself remains visible in the export result and diagnostic.
Do not add field selection, payload truncation, or task-level observation suppression.

Backpressure must propagate to producers that support it.
For callback-only producers, preserve the existing overflow failure and diagnostic semantics.
Never silently drop required events or report successful delivery after transport failure.
When the terminal event cannot be delivered, the CLI must fail through its supervision path.
Runner IPC sends wait for callback acknowledgement with a bounded five-second
deadline. An unacknowledged event or terminal send is a transport failure and
must settle through the same supervisor failure path.

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
Private validated ownership records identify processes acquired by the worker,
including native adapter startup and preflight. Register ownership before
external work and acknowledge the control record. Release ownership only after
native process or group termination is confirmed. A control delivery failure
must clean the acquired resource and fail through supervision.
The CLI verifies process identity before forced cleanup and waits for actual
exit. A reused PID or unconfirmed identity must never authorize a signal to a
foreign process. External services remain outside worker ownership.
These private records do not change public Plans or the execution-event version.
Plan and replay commands retain their current behavior and Zod validation.
Remove `unstable_studio` after hosted inspection parity; update help and documentation with its replacement inspection paths.

### requirement-action-lifetimes

Keep all six Actions on Node 24 with thin Actions Toolkit adapters. Evaluate
native Effect programs at main and post composition boundaries. Keep pure
review, conflict, and publication transformations pure.

Readiness, installation, startup cleanup, and shutdown use finite native
deadlines. A service outlives main only after validated ownership is saved and
the resident process acknowledges adoption. Partial startup and cancellation
retain cleanup ownership. Post validates process birth and group ownership
before each signal; a surviving verified sentinel can retain that ownership.
Malformed state or a reused PID cannot authorize foreign-process termination.
Report uncertain cleanup explicitly.

Preserve Action inputs, outputs, secret handling, exact publication identity,
confirmation, and byte bounds. Do not retry publication writes generically.
Commit and push remain independently controlled by the operator.

Build all main, post, and resident assets together. Bundle runtime dependencies
and keep generated assets ignored. Published packages contain production
entrypoints and declarations, without development runners, crash fixtures, or
private test-support modules. Verify consumption outside the checkout.

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

The hosted DTOs use `version: 1`. Start accepts `input`, optional `workId` and
`runId`, and an optional private runtime profile reference. It returns the
allocated run reference immediately. Run lifecycle states are `queued`,
`running`, `succeeded`, `failed`, `cancelled`, and `interrupted`.
The outcome and inspection completeness are separate fields.

Keep `/healthz`, `/readyz`, `/api/workflows`, and workflow-scoped run paths.
Global `/api/runs` inspection routes use the same records and DTOs.
Event cursors are exclusive sequence numbers. Pages retain whole canonical
events in ascending order. `nextSequence` identifies the last returned event,
or keeps the requested cursor when the page is empty. Missing history has an
explicit inclusive gap range. Pagination must bound serialized bytes as well
as row count. Active or failed inspection cannot claim completeness.

MCP workflow tools use `/api/mcp/seqlane-workflows/mcp` and the same start
envelope. Support the pinned native session protocols and the native sessionless
protocol with their required negotiation, routing headers, and request metadata.
Cancellation and deadlines must drain the admitted run before releasing capacity.

Persist hosted run metadata, terminal results, canonical events/observations, and correlated inspection data with a versioned schema.
Use transactions for related state and sequence updates.
Flush accepted hosted data before reporting terminal inspection complete.
Report storage failure or incomplete inspection explicitly without silently inventing history or changing a completed task result.
On restart, mark interrupted runs without rerunning their external actions.

Each history database has one host owner. Use SQLite connection locking to
reject another owner before startup recovery can change live run state.
Concurrent clients use the owning host's HTTP or MCP endpoint. Connection
closure or process death releases ownership without a separate stale lock file.

Use a fresh database for the new schema. Do not overwrite, open as the new format, or automatically remove old history.
Document the history discontinuity and keep new history inspectable after restart.

### requirement-operational-registration-and-bounds

Workflow registration requires a non-empty description, valid identifiers,
input/output schemas, and a validated Plan/registry. Invalid registration fails
before exposing a callable workflow. Discovery does not execute workflow tasks.
Descriptor listing does not import workflow modules; planning imports only the
selected trusted module and starts no agent, model, task, or task process.
Standalone `run` bypasses catalogs and uses an explicit entrypoint.

Discovery has explicit depth, file-count, workflow-count, and startup-time
budgets. Do not follow symbolic links outside declared roots. Limit and
containment failures use typed errors before registration. Where qualified
repository/user discovery is exposed, reject ambiguous unqualified names.

Unauthenticated operational access is local only. Loopback URL validation
accepts `localhost`, `127.0.0.1`, and `[::1]`; non-loopback or multi-user access
requires a separate authenticated authorization design. Preserve origin checks,
transport validation, deadlines, cancellation, and finite concurrency limits.
Run, event, result, and trace queries bound rows and serialized bytes, with
explicit continuation, gaps, and completeness. Hosted data has an explicit
retention/cleanup policy; cleanup never removes an active run's required state.

All hosted surfaces read the same authoritative run records, identities,
normalized outcomes, observations, and correlated traces. There is no second
canonical run store or reconstruction from terminal text.

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

Nested graphs share one run body limit, repeat budget, admission registry, and invocation creation order. Container orchestration does not consume a task-body permit while it waits for children.

Workflow containers reserve all affected resources atomically. Each resource uses the strongest policy required by the authored container and its possible descendants, including choices, repeat attempts, and output evaluators. Fully shared subtrees remain shareable. Waiting containers retain no partial reservation.

Each invocation has a distinct workspace owner and an explicit ancestor chain. Ancestor reservations permit contained work without permitting conflicting siblings. A descendant can pass a foreign waiter that is blocked by its ancestor reservation. Child invocations retain their authored workspace policies. Unconfirmed descendant activity quarantines the affected ancestor reservations.

Retain typed domain errors at package boundaries and preserve original causes.
Map Effect typed failure, defect, and interruption to the existing domain result contract once at the run boundary.
Do not serialize Effect `Cause`, fibers, scopes, or opaque third-party state over the protocol.

## Failure and edge cases

Required cases include cancellation before import, during acquisition, during admission, during execution, and during final flush.
Cover dependency failure, nested cancellation, unselected choice input errors, exhausted repeat budgets, late SDK rejection, and uncertain external termination.
Cover malformed replay, large observations, blocked IPC, exporter outage, hosted storage loss, and process crashes.
Never claim cleanup guarantees after SIGKILL or machine loss.

## Migration

Retained product and detailed semantic requirements have current canonical owners.
S0 records the authority transition; S1–S11 record scoped implementation evidence.
S12 records complete removal, final artifact inspection, and exact-head hosted CI.
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

Active target contract. [S1](../tasks/2026-10-21-effect-v4-effect-tracer.md) verifies the Effect process boundary. [S2](../tasks/2026-10-21-effect-v4-dependency-graphs.md) verifies dependency graphs through the private CLI worker composition and direct runtime facade. [S3](../tasks/2026-10-21-effect-v4-sessions-and-workspace-admission.md) verifies sessions, workspace admission, observations, and scoped cleanup through those callers. [S4](../tasks/2026-10-21-effect-v4-nested-workflows-and-validation.md) verifies nested workflows, choices, repeats, shared limits, validation, and cleanup. [S5](../tasks/2026-10-21-effect-v4-native-adapters-and-observations.md) verifies native adapters, full observations, and confirmed cleanup. [S6](../tasks/2026-10-21-effect-v4-acp-transport.md) verifies official ACP transport, complete native updates, and confirmed process cleanup. [S7](../tasks/2026-10-21-effect-v4-classifier-and-deadlines.md) verifies classifier HTTP, native retry schedules, monotonic transport deadlines, and mixed workflows through direct and compiled CLI callers. [S8](../tasks/2026-10-21-effect-v4-telemetry-and-event-pressure.md) verifies real CLI-to-adapter trace correlation, canonical observations, native metrics and logs, bounded event delivery, acknowledgement deadlines, isolated OTLP export, and cleanup. [S9](../tasks/2026-10-21-effect-v4-cli-and-action-cutover.md) verifies the sole CLI/direct Action run program, native ownership control, bounded supervision, original failure causes, plan/replay orchestration, and compiled caller parity. [S10](../tasks/2026-10-21-effect-v4-hosted-history-and-inspection.md) verifies native HTTP/MCP, versioned operational contracts, transactional SQL inspection, cancellation and admission ownership, persisted canonical observations, restart inspection, and crash recovery without replay. [S11](../tasks/2026-10-21-effect-v4-remaining-actions-and-distribution.md) verifies all six Actions, shared libraries, production distributions, and actual hosted entry/post execution. [Hosted CI](https://github.com/marcolink/seqlane/actions/runs/39744581106) passes. [S12](../tasks/2026-10-21-effect-v4-complete-removal-and-release.md) completes requirement transfer, removal, all 23 package audits, rebuilt artifacts, installed-package consumption, and release dry runs. [Implementation-checkpoint CI](https://github.com/marcolink/seqlane/actions/runs/39751001939) passes. Final documentation reconciliation changes no executable code. The reachable S12 task commit and its exact-head CI in [branch history](https://github.com/marcolink/seqlane/actions/workflows/ci.yml?query=branch%3Afeat%2Feffect-v4-migration) establish feature-branch delivery. No default-branch merge or registry publication is claimed.

## Traceability

- Supersedes [the earlier sequential runtime contract](./2026-09-02-effect-runtime-integration.md).
- Supersedes [the earlier dedicated runner contract](./2026-09-02-dedicated-runner-process.md).
- Supersedes [the earlier local read-only Studio contract](./2026-09-02-local-read-only-execution-studio.md).
- Supersedes [the earlier Studio lifecycle contract](./2026-09-02-local-development-studio-trust-and-lifecycle.md).
- Supersedes [the earlier Studio development and replay contract](./2026-09-02-studio-vite-development-and-isolated-replay.md).

- [rfc.effect-v4-migration: Migration proposal](../rfcs/2026-10-21-effect-v4-migration.md)
- [prd.seqlane-runtime: Product requirements](../prd/2026-10-21-seqlane-runtime.md)
- [Delivery task](../tasks/2026-10-21-migrate-all-packages-to-effect-v4.md)
- [Workflow authoring and execution semantics](./2026-10-22-workflow-execution-semantics.md)
- [Adapter observation lifecycle and projection](./2026-10-22-adapter-observation-projection.md)
- [Standalone CLI](./2026-09-16-standalone-cli-runs.md)
- [Runner process](./2026-09-02-dedicated-runner-process.md)
- [Machine output](./2026-09-15-run-machine-output.md)
- [Terminal output](./2026-09-15-run-terminal-rendering.md)
- [Draft observation vocabulary and OTel mapping](./2026-09-19-otel-aligned-observation-contract.md)
- [Adapter contracts](./2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [Session model semantics](./2026-09-03-model-selection-and-session-model-semantics.md)
- [Repeat semantics](./2026-09-14-fluent-task-until-repeats.md)
- [Classifier contracts](./2026-09-23-classifier-tasks.md)
