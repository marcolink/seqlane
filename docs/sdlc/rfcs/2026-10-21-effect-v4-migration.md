---
id: rfc.effect-v4-migration
title: Full Effect v4 Migration
status: accepted
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - prd.seqlane-runtime
  - brd.seqlane
supersedes:
  - adr.engine-opaque-agent-adapter-contracts
  - adr.seqlane-plan-ir-and-typed-dataflow
  - adr.fluent-seqlane-flow-dsl
  - adr.effect-private-runtime-engine
  - adr.dedicated-runner-process
  - adr.local-read-only-execution-studio
  - adr.local-development-studio-trust-and-lifecycle
  - adr.studio-vite-development-and-isolated-replay
  - rfc.seqlane-technical-architecture
  - rfc.high-fidelity-local-observability
---

# Full Effect v4 Migration

## Summary

Use Effect v4 execution and services across every workspace package.
Keep Oclif for CLI commands, flags, argument validation, help, and exit conventions.
Keep Zod as the canonical validator for public and wire contracts, as the user requested.
Preserve Seqlane authoring semantics, canonical observations, terminal output, and hosted inspection.

The final tracked tree and distributions contain only the selected runtime integration, with no retired engine code, dependency, name, documentation, fixture, skill, or generated artifact.
Git history and previously published releases remain unchanged.
This accepted RFC records the architecture decision and migration plan. It does not claim runtime delivery.

## Context

The workspace contains 23 package manifests. CLI, direct Action callers, HTTP,
and MCP share one run-scoped Effect program. Public workflow definitions,
Plans, serialized events, and CLI results stay engine-independent.

Standalone runs are ephemeral. Hosted persistence and inspection are explicit
capabilities with a fresh versioned database. Canonical protocol events remain
the source of truth for observations; traces, logs, metrics, and TUI views are
projections. Package and release verification establishes delivery separately
from this accepted architecture decision.

## Goals

- Use Effect for application execution, concurrency, resource ownership, time, retries, streams, and operational telemetry.
- Migrate all packages, CLI commands, direct runtime callers, Actions, and examples.
- Preserve the public DSL, Plan data, Zod contracts, and executor independence.
- Preserve full available observation payloads, identity, timing, usage, cost, and diagnostic information.
- Preserve standalone isolation and hosted inspection without two competing execution stores.
- Delete each replaced path and complete a repository-wide removal audit.

## Non-goals

- Replace Oclif, Ink, React, Nx, pnpm, native agent SDKs, or Zod merely to increase Effect usage.
- Rewrite pure transformations as effects or add Effect dependencies to packages that only contain pure contracts.
- Add automatic replay of coding actions, distributed workers, or durable resume as part of this migration.
- Rewrite Git history, remove user databases, or alter installed agent authentication and permissions.
- Build a replacement Studio application.

## Documentation impact

Classification: architecture change with operational contract changes.

- PRD owns retained product requirements, including typed workflows, choice,
  classifier behavior, sessions, workspace policy, output quality, and distribution.
- This RFC owns the selected runtime architecture and package dispositions.
- The Effect specification owns run programs, external resources, telemetry,
  CLI/Action composition, hosted inspection, and final removal gates.
- Focused workflow and adapter-observation specifications own the transferred
  detailed semantics; specialized neutral contracts remain authoritative.
- Tasks own scoped delivery evidence. The final gate retains release and
  exact-head CI requirements.

Retained requirements have target-only canonical owners. Obsolete engine
records can be removed after their inbound IDs and links are reconciled.
The complete-removal decision overrides normal tracked historical retention;
Git history remains available. This transfer makes no historical Effect claim.

## Decision

### decision-one-effect-program

Compile the validated Plan into one run-scoped Effect program.
The CLI runner, direct Action entrypoint, HTTP host, and MCP host invoke that same program.
Seqlane owns Plan meaning and policy. Effect owns execution mechanisms and resource lifetimes.

```text
Oclif / Action / HTTP / MCP composition root
                       |
                validate with Zod
                       |
              scoped Effect Plan program
          +------------+-------------+
          |            |             |
      local task   classifier    generic adapter
          |            |             |
     scoped process  HTTP client  concrete native SDK
                       |
               canonical event sink
          +------------+-------------+
          |            |             |
       CLI/TUI     hosted store    telemetry projection
                                 spans / logs / metrics
```

Use the existing validated Plan and ordering rules.
A thin Plan interpreter owns domain interpretation; Effect owns dependency waiting, concurrency, scopes, and interruption.
Use `Deferred` for dependency completion and scoped fibers for node execution.
Use bounded Effect concurrency for runnable bodies, not for fibers that only wait on dependencies.
Otherwise a waiting dependent can consume the permit required by its prerequisite.
Independent ready nodes must start without a whole-level barrier.

Preserve static session/workspace edges, dynamic admission, invocation identity, nested containment, and result bindings.
Acquire session and workspace eligibility together. Never hold one resource while waiting for the other.
Cancellation must remove waiters and release only confirmed resources.

### decision-interop-boundaries

Public authoring and wire contracts stay engine-independent and Zod-owned.
Existing Promise task callbacks remain supported application boundaries.
Private runtime services, adapter orchestration, classifier calls, and Action orchestration become Effect programs.
Pure DSL, Plan, rendering, and publication functions remain pure.

Convert SDK Promises and callbacks once at the owning integration edge.
Bridge Effect back to Promises only for Oclif, public task context callbacks, React/Ink lifecycle, native SDK hooks, and existing external runtime entrypoints.
Do not call `runPromise` inside the Plan scheduler, retry policy, event reducer, or adapter business logic.
Interop must preserve the owning scope, parent span, interruption, and original cause.
A Promise wrapper around the old scheduler does not satisfy migration.

The run program acquires its resources in a scope and evaluates only at the
owning composition boundary:

```ts
const program = Effect.gen(function* () {
  const execution = yield* acquirePlanExecution(options);
  return yield* execution.run(request);
}).pipe(Effect.scoped, Effect.withSpan("seqlane.run"));

return Effect.runPromise(program.pipe(Effect.provide(RunLive)));
```

These illustrative helper names describe ownership, not an exported API or
compiled delivery evidence. Acquisition registers cleanup before external work,
including partial-acquisition failure.

### decision-effect-capabilities

The official reference lists `effect@4.0.5` at planning time.
Use exact pins and verify installed exports and declarations before implementation.
Do not infer companion package versions from the core version.

| Responsibility                 | Selected Effect v4 capabilities                               | Limit                                                               |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Service composition            | `Context.Service`, `Layer`, scoped acquisition                | Services represent real callers, not a generic dependency framework |
| Run and invocation lifecycle   | `Effect`, `Fiber`, `Scope`, `Exit`, `Cause`                   | One root outcome and structured child lifetime                      |
| Plan execution                 | `Deferred`, bounded concurrency, `Ref`                        | Preserve domain ordering and fail/skip rules                        |
| Joint admission                | Transactional state or one atomic coordinator with `Deferred` | Preserve atomic session/workspace admission                         |
| Deadlines and retries          | `Clock`, `Schedule`, timeout and retry operators              | Preserve policy boundaries and attempt accounting                   |
| Events and adapter streams     | `Stream`, bounded `Queue`, explicit sink acknowledgement      | Required events cannot be silently dropped                          |
| Process execution              | `effect/process` with Node process services                   | Prove process-tree termination and argv semantics                   |
| Classifier and host networking | `effect/http`, `effect/httpapi`, Node HTTP services           | Zod remains the boundary validator                                  |
| Hosted inspection              | Effect SQL and a Node SQLite driver                           | Run history only; no new replay scheduler                           |
| MCP                            | `effect/ai` MCP server primitives                             | Verify supported protocol versions and cancellation                 |
| Telemetry                      | `Tracer`, `Logger`, `Metric`, `effect/observability` OTLP     | Export is a projection of canonical data                            |
| Tests                          | `TestClock`, test layers, compatible `@effect/vitest`         | Real subprocess tests still prove OS behavior                       |
| Private data                   | `Schema`, `Config`, `Redacted` where useful                   | No duplicate public or wire schemas                                 |

The Workflow/Activity APIs also exist. They are not required for ordinary Plan execution.
Their persistence and replay semantics do not establish safe replay of workspace mutations or agent calls.
Use a scoped Plan program for both standalone and hosted runs; hosted persistence records execution rather than resuming it.
Cluster, RPC workers, durable workflows, and provider AI clients remain available for a later requirement with a real caller.
Effect AI does not replace OpenCode, Codex, or ACP harness semantics.

Several selected integration modules are marked unstable despite the stable core release.
Isolate those imports at owned integration files and test exact pinned APIs.

### decision-zod-ownership

Retain Zod for core schemas, protocol envelopes, CLI input, adapter input, Action input, and public output validation.
Retain `z.infer`, defaults, transforms, strictness, error categories, and existing JSON Schema generation semantics.

Private Effect Schema use is optional for a genuinely private contract.
When an Effect HTTP or MCP primitive requires Effect Schema, use one interop adapter that delegates to the owning Zod validator.
Do not maintain a second handwritten shape. Generated JSON Schema is a description, not a replacement for runtime validation.
Test defaults, transforms, strict objects, unions, malformed input, and unsupported JSON Schema conversion at this edge.

### decision-observability

The protocol-owned event stream remains canonical.
Neither Effect spans nor the hosted database reconstruct missing task or model data.

| Data              | Required behavior                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Correlation       | Preserve Work, Run, Invocation, containment, iteration, attempt, exchange, activity, and source sequence |
| Task values       | Preserve full valid JSON input, result, validation, activity, and observation values                     |
| Model exchanges   | Preserve available request/response, provider/model, tokens, cost, timing, and repair attempts           |
| Tools and skills  | Preserve available input/output/metadata, identity, parentage, updates, and terminal state               |
| Availability      | Report unavailable native fields explicitly; never invent values                                         |
| Trace projection  | One run span, nested workflow/invocation spans, model/tool/skill spans and links                         |
| Logs              | Structured diagnostics with correlation; never corrupt final JSON stdout                                 |
| Metrics           | Durations, outcomes, waits, retries, tokens, cost, payload bytes, queue pressure, export failures        |
| Cardinality       | No raw payload, prompt, output, or per-run identifier in metric labels                                   |
| Failure isolation | Exporter failure cannot change execution results or suppress canonical events                            |
| Retention         | Keep current complete-record eviction and visible eviction notices in the TUI                            |

Create operational spans around execution before it starts.
Project canonical observations to detailed spans without a second native-adapter trace tree.
Pass an explicit validated trace carrier across process boundaries. In-process SDK bridges inherit the active Effect context.
Trace IDs correlate execution but do not replace Seqlane identities.

Local observation capture remains complete by default.
Remote export remains explicit. Do not attach remote exporters or send raw model data because OTLP is available.
Exporter limits can omit projection data with a diagnostic; they cannot truncate canonical payloads.
Separate telemetry queues from required event delivery and preserve shutdown ordering.

Standalone `run` creates no history, database, recording, log file, or export file.
Existing replay consumes supplied files; this migration does not add `run --record`.
Hosted persistence remains an explicit host capability, with a versioned schema and flush on terminal settlement.

### decision-cli-and-host

| CLI surface       | Target behavior                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `run`             | Same Oclif parsing, supervised child, explicit entrypoint, lazy adapter, dry-run, input modes, output modes, and exits    |
| `unstable_plan`   | Same discovery and Plan display through Zod and pure compilation                                                          |
| `unstable_replay` | Same supplied recording validation, sequencing, and human/JSON replay                                                     |
| `unstable_serve`  | Effect HTTP host, same workflow capabilities, health/readiness, hosted history, cancellation, and MCP                     |
| `unstable_studio` | Remove the upstream-specific launcher; document TUI, replay, hosted inspection, and optional Effect DevTools/OTLP viewers |
| Help and errors   | Remove obsolete names, flags, examples, aliases, defaults, and package-resolution checks                                  |

Studio launcher removal is an intentional CLI change in this proposal.
Effect DevTools is a developer tool, not a claim of equivalent persistent workflow inspection.
Preserve hosted run/result/trace inspection through engine-neutral host APIs before removing the launcher.
Do not add a custom web UI to close that gap.

Host composition keeps `libs/runtime` independent of concrete adapters.
The host provides typed Effect services for execution, registry access, hosted history, and telemetry.
HTTP and MCP must share the same run identity, cancellation handle, and event stream.
Keep loopback binding, origin checks, concurrency bounds, and shutdown behavior.

Operational clients consume protocol-owned Zod DTOs.
Retain useful existing endpoint paths where possible; do not expose or recreate the previous framework API wholesale.
Inventory each consumed endpoint before removal. The target contract defines the required operations.

Use a fresh versioned hosted database, such as `.seqlane/operations.db`.
Never open the old database as the new schema or delete it automatically.
Existing history remains in its original file; in-place conversion and old-history import are outside this migration.
Document this intentional history discontinuity. New hosted runs must remain inspectable after restart.
Mark unfinished runs interrupted after host loss; do not replay side effects.

## Architecture and boundaries

Every package has an explicit disposition. “Audit” includes source, dependencies, tests, exports, documentation, and build output. S1–S11 record scoped verification. S12 records the final complete-tree, production dependency, and distribution audit. All 23 package dispositions pass.

| Package path                            | Required disposition                                                                                                                                  | Scoped result and remaining gate                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `libs/core`                             | Keep DSL, Plan, identity, Zod, and public Promise callbacks. Remove engine language and strengthen public-boundary tests                              | S4/S7 public contracts; S12 source, dependency, and distribution audit passes                   |
| `libs/protocol`                         | Keep canonical Zod schemas, serialization, versioning, observation semantics, and malformed-input checks. Own new operational DTOs                    | S8/S10 event and hosted contracts; S12 source, dependency, and distribution audit passes        |
| `libs/runtime`                          | Replace engine compilation, envelopes, execution, local processes, host, storage, telemetry, and duplicate lifecycle code with Effect                 | S1–S10 execution and operations; S12 source, dependency, and distribution audit passes          |
| `libs/adapter`                          | Keep one generic capability contract, Effect-owned orchestration, and canonical observation sinks without engine-context obligations                  | S5 generic adapter boundary; S12 source, dependency, and distribution audit passes              |
| `libs/opencode`                         | Keep native SDK/harness. Scope connections, streams, checkpoints, forks, repair attempts, and cleanup; replace native trace projection                | S5 native adapter; S12 source, dependency, and distribution audit passes                        |
| `libs/codex`                            | Keep native app-server transport. Migrate connection, stream, request, cancellation, and process lifetimes; preserve observation availability         | S5 native adapter; S12 source, dependency, and distribution audit passes                        |
| `libs/acp`                              | Use the official ACP SDK client. Preserve ACP v1 negotiation, permissions, model selection, output repair, and capability reporting                   | S6 official SDK transport; S12 source, dependency, and distribution audit passes                |
| `libs/tui`                              | Keep Ink/React and pure reducers. Migrate stream subscription/disposal where needed; preserve complete values and passive terminal behavior           | S8/S9 observation and output parity; S12 source, dependency, and distribution audit passes      |
| `libs/fixtures`                         | Replace engine fixtures with portable workflow fixtures and reusable Effect test services                                                             | S4/S9 shared runtime fixtures; S12 source, dependency, and distribution audit passes            |
| `libs/action-code-review`               | Execute through the common Effect program. Migrate I/O and cancellation; preserve pure review state, publication limits, and exact write confirmation | S9/S11 direct caller and distribution; S12 source, dependency, and distribution audit passes    |
| `libs/action-merge-conflict-resolution` | Migrate agent runner, workspace/process operations, and cancellation; remove old observation forwarding                                               | S11 Action orchestration; S12 source, dependency, and distribution audit passes                 |
| `libs/action-service-lifecycle`         | Scope service acquisition, readiness, teardown, and bounded retries for its real Action consumers                                                     | S11 service lifetimes; S12 source, dependency, and distribution audit passes                    |
| `apps/cli`                              | Effect command/application orchestration behind Oclif; runner supervision and output parity; host/replay/plan migration; launcher removal             | S9/S10 CLI and hosted inspection; S12 source, dependency, and distribution audit passes         |
| `apps/docs`                             | Rewrite architecture, setup, operation, observability, and examples. Keep VitePress                                                                   | S12 transfer, public docs build, and 350-document validation pass                               |
| `workflows/code-review`                 | Preserve workflow behavior and Zod schemas. Migrate affected callback integration and verify review fixture results                                   | S11 consuming workflow audit; S12 source, dependency, and distribution audit passes             |
| `workflows/read-context`                | Preserve behavior and Zod schemas. Verify deterministic and agent execution through Effect                                                            | S11 consuming workflow audit; S12 source, dependency, and distribution audit passes             |
| `workflows/resolve-merge-conflicts`     | Preserve workflow behavior, session/workspace policy, and schemas. Verify conflict-resolution fixtures                                                | S11 consuming workflow audit; S12 source, dependency, and distribution audit passes             |
| `actions/code-review`                   | Effect composition behind Actions SDK entry/post hooks; rebuild and inspect both bundles                                                              | S11 hosted Action main/post verification; S12 source, dependency, and distribution audit passes |
| `actions/resolve-merge-conflicts`       | Same runtime and lifecycle migration; preserve Action inputs, outputs, and non-interactive behavior                                                   | S11 hosted Action main/post verification; S12 source, dependency, and distribution audit passes |
| `actions/opencode-server`               | Effect-backed lifecycle helper; preserve ready/owned-service/post-cleanup behavior                                                                    | S11 hosted Action main/post verification; S12 source, dependency, and distribution audit passes |
| `actions/ripwire-server`                | Same service lifecycle; preserve Zod input contract and transport behavior                                                                            | S11 hosted Action main/post verification; S12 source, dependency, and distribution audit passes |
| `actions/zvec-grep-server`              | Same service lifecycle; preserve transport, ownership, and cleanup                                                                                    | S11 hosted Action main/post verification; S12 source, dependency, and distribution audit passes |
| `actions/setup-opencode`                | Scope download/cache/tool operations behind Effect; preserve Actions SDK and Zod input contract                                                       | S11 hosted Action main/post verification; S12 source, dependency, and distribution audit passes |

Root tooling also changes: manifests, lockfile, Nx inputs/tags, TS references, release checks, CI, hooks, root docs, and tracked skills.
Keep existing short Action library boundaries. Do not introduce a generic Action framework.
Maintenance scripts can keep direct Node APIs when no application lifecycle requires Effect.

## Alternatives considered

Wrapping the current runtime in `Effect.tryPromise` retains two lifecycle owners and does not meet the removal goal.
Replacing Zod or Oclif conflicts with the selected scope.
Replacing coding harnesses with Effect AI changes agent behavior and does not follow from a runtime migration.
Using durable Workflow or Cluster for every run adds replay and deployment requirements without a current product caller.
Replacing every pure function with Effect adds dependencies without changing execution safety.

## Risks and trade-offs

| Risk                                                   | Required evidence or response                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Interruption stops a fiber but external work continues | Real process/SDK termination evidence; quarantine workspace/session ownership until termination is confirmed |
| Failure fan-out changes observable results             | Compare error category, cause, skip reasons, partial output, and single terminal settlement                  |
| Native context disappears at Promise or IPC edges      | Parent-span and identity tests across CLI, Action, nested workflow, and adapter paths                        |
| New queue loses large observations                     | Byte-pressure, ordering, overflow, shutdown, and no-truncation tests                                         |
| ACP replacement changes harness behavior               | Official SDK protocol fixture plus installed-agent smoke test, with capability gaps explicit                 |
| Hosted inspection regresses                            | Persisted run/result/observation queries after restart and terminal flush tests                              |
| SQLite blocks the event loop under contention          | Short transactions, explicit busy timeout, and concurrent-run measurements before host cutover               |
| Integration modules change within v4                   | Exact pins, owned imports, installed declaration checks, and focused integration tests                       |
| Broad cleanup breaks traceability                      | Regenerate links/indexes after contract transfer, then validate the entire corpus                            |

Security and license verification covers the complete production dependency
closure at the final release gate. A direct package/version check alone does
not prove transitive dependency safety or current artifact contents.

## Migration or rollout

Deliver the vertical slices in the linked task. Start with one real CLI-to-process-to-observation path.
Each slice names its base, observable evidence, replaced callers, and deletion condition.
No release ships a permanent engine selector, fallback path, or dual write.

Rollback uses the previous complete commit/release, not a fallback engine.
Use additive hosted schema migrations during development and keep old databases untouched.
Do not promote a failed tracer or infer readiness from document status.

Retained contracts live in the linked current owners. Final verification audits
all tracked names and content, dependency closure, and rebuilt release artifacts.
Relationships reference extant target-only stable IDs and canonical paths.
History remains recoverable through Git.

## Open questions

No product-scope question blocks this plan. Oclif and public/wire Zod are explicit constraints.
Exact companion package versions and platform termination behavior are implementation verification gates, not assumed results.
Launcher removal and the fresh hosted-history format are explicit behavior changes; the runtime specification owns their inspection and recovery requirements.

## Delivery state

Architecture accepted and target contracts active. [S1](../tasks/2026-10-21-effect-v4-effect-tracer.md) records branch-local process evidence. [S2](../tasks/2026-10-21-effect-v4-dependency-graphs.md) records dependency-graph parity through the private CLI and direct compositions. [S3](../tasks/2026-10-21-effect-v4-sessions-and-workspace-admission.md) records session lineage, atomic admission, observations, and cleanup through both compositions. [S4](../tasks/2026-10-21-effect-v4-nested-workflows-and-validation.md) records nested execution, choices, repeats, validation, shared limits, and cleanup. [S5](../tasks/2026-10-21-effect-v4-native-adapters-and-observations.md) records native adapter ownership, full observations, and confirmed cancellation. [S6](../tasks/2026-10-21-effect-v4-acp-transport.md) records official ACP transport ownership, complete native updates, and confirmed process cleanup. [S7](../tasks/2026-10-21-effect-v4-classifier-and-deadlines.md) records classifier transport ownership, native retry schedules, monotonic deadlines, and mixed direct/CLI caller evidence. [S8](../tasks/2026-10-21-effect-v4-telemetry-and-event-pressure.md) records real trace correlation, complete observations, native metrics and logs, bounded required-event delivery, and isolated optional OTLP export. [S9](../tasks/2026-10-21-effect-v4-cli-and-action-cutover.md) records production CLI/direct Action cutover, shared native process identity, bounded supervision, original failure causes, and compiled caller parity. [S10](../tasks/2026-10-21-effect-v4-hosted-history-and-inspection.md) records native hosted HTTP/MCP, transactional SQL history, versioned inspection, cancellation and admission ownership, persisted observations and traces, and crash recovery without replay. [S11](../tasks/2026-10-21-effect-v4-remaining-actions-and-distribution.md) records all six Actions, shared libraries, production distributions, and actual hosted entry/post verification with [passing CI](https://github.com/marcolink/seqlane/actions/runs/39744581106). [S12](../tasks/2026-10-21-effect-v4-complete-removal-and-release.md) completes requirement transfer, full removal, all 23 package audits, installed packages, clean artifacts, and release dry runs. [Implementation-checkpoint CI](https://github.com/marcolink/seqlane/actions/runs/39751001939) passes; the final task commit reconciles documentation only. Delivery is the reachable S12 task commit with passing CI on its exact published head, recorded in [branch CI history](https://github.com/marcolink/seqlane/actions/workflows/ci.yml?query=branch%3Afeat%2Feffect-v4-migration). No default-branch merge or registry publication is claimed.

## Traceability

- [brd.seqlane: Business requirements](../brd/2026-09-02-seqlane.md)
- [prd.seqlane-runtime: Product requirements](../prd/2026-10-21-seqlane-runtime.md)
- [Workflow authoring and execution semantics](../specs/2026-10-22-workflow-execution-semantics.md)
- [Adapter observation lifecycle and projection](../specs/2026-10-22-adapter-observation-projection.md)
- [Standalone CLI contract](../specs/2026-09-16-standalone-cli-runs.md)
- Supersedes [the earlier private-runtime decision](../adrs/2026-09-02-effect-private-runtime-engine.md).
- Supersedes [the earlier technical architecture](./2026-09-02-seqlane-technical-architecture.md).
- Supersedes [the local high-fidelity proposal](./2026-09-19-high-fidelity-local-observability.md).
- Supersedes [the dedicated runner decision](../adrs/2026-09-02-dedicated-runner-process.md).
- Supersedes [the local read-only Studio decision](../adrs/2026-09-02-local-read-only-execution-studio.md).
- Supersedes [the local Studio lifecycle decision](../adrs/2026-09-02-local-development-studio-trust-and-lifecycle.md).
- Supersedes [the Studio development and replay decision](../adrs/2026-09-02-studio-vite-development-and-isolated-replay.md).
- Supersedes [the earlier Plan representation decision](../adrs/2026-09-02-seqlane-plan-ir-and-typed-dataflow.md).
- Supersedes [the earlier fluent DSL decision](../adrs/2026-09-02-fluent-seqlane-flow-dsl.md).
- Supersedes [the opaque adapter context decision](../adrs/2026-09-18-engine-opaque-agent-adapter-contracts.md).
- [Canonical observation fields and OTel mapping](../specs/2026-09-19-otel-aligned-observation-contract.md)
- [Effect migration target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [Effect migration delivery task](../tasks/2026-10-21-migrate-all-packages-to-effect-v4.md)

### External evidence, inspected 2026-10-21

- [Effect v4 onboarding](https://effect.website/docs/v4/onboarding)
- [Core API and version](https://effect.website/docs/v4/api/effect)
- [Service API](https://effect.website/docs/v4/api/effect/Context)
- [Process command API](https://effect.website/docs/v4/api/effect/process/ChildProcess)
- [Node process implementation](https://effect.website/docs/v4/api/platform-node-shared/NodeChildProcessSpawner)
- [MCP server API](https://effect.website/docs/v4/api/effect/ai/McpServer)
- [OTLP export API](https://effect.website/docs/v4/api/effect/observability/Otlp)
- [OTLP tracer lifecycle](https://effect.website/docs/v4/api/effect/observability/OtlpTracer)
- [Workflow engine and in-memory limits](https://effect.website/docs/v4/api/effect/workflow/WorkflowEngine)
- [Node SQLite client and contention limits](https://effect.website/docs/v4/api/sql-sqlite-node/SqliteClient)
- [Official ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [Snyk core package](https://security.snyk.io/package/npm/effect)
- [Snyk core version](https://security.snyk.io/package/npm/effect/4.0.5)
