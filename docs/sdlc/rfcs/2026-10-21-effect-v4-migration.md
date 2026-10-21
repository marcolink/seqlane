---
id: rfc.effect-v4-migration
title: Full Effect v4 Migration
status: accepted
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - prd.seqlane-runtime
  - brd.seqlane
supersedes:
  - rfc.mastra-runtime-and-operational-foundation
  - adr.mastra-backed-seqlane-workflows
  - adr.mastra-local-mechanical-tasks
---

# Full Effect v4 Migration

## Summary

Replace Mastra across every workspace package with Effect v4 execution and services.
Keep Oclif for CLI commands, flags, argument validation, help, and exit conventions.
Keep Zod as the canonical validator for public and wire contracts, as the user requested.
Preserve Seqlane authoring semantics, canonical observations, terminal output, and hosted inspection.

The final tracked tree must contain no Mastra code, dependency, name, documentation, fixture, skill, or generated artifact.
Git history and previously published releases remain unchanged.
This accepted RFC records the architecture decision and migration plan. It does not claim runtime delivery.

## Context

The source snapshot inspected for this inventory was commit `51249b721a340959702e550fb84e7a3bd51ed59f` in a detached, initially clean checkout. This records the state of that snapshot only; it does not describe the current branch or establish delivery on `main`.

The workspace has 23 package manifests. Direct dependencies occur in four packages:

| Package         | Current dependency or responsibility                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `libs/runtime`  | `@mastra/core`, Hono integration, LibSQL storage, MCP, observability, server, graph compilation, local processes |
| `libs/acp`      | `@mastra/acp`, `@mastra/core`, agent transport, observation projection                                           |
| `libs/opencode` | `@mastra/core` for native observation projection                                                                 |
| `apps/cli`      | `mastra` for the hidden Studio command                                                                           |

`git grep -il mastra` found 255 tracked files, including 171 under `docs/sdlc`.
The remaining matches include source, tests, package metadata, skills, CI, and lint configuration.
These numbers describe the inspected checkout and must be regenerated before implementation.

Current execution paths include both the supervised CLI runner and direct Action callers:

```text
Oclif run -> runner child -> load/validate Plan -> createMastraPlanExecution
Action -> startWorkflowRun ------------------> createMastraPlanExecution
                                                 |
                                       compiler / runtime / adapters
                                                 |
                              canonical events + native trace projection
```

`run` is ephemeral. Hosted commands provide separate persistence and inspection.
The runner and `startWorkflowRun` duplicate lifecycle work; both must converge on one Effect program.
The existing Promise dependency program is another migration target, not an engine to retain under a new name.

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

Classification: architecture change, with operational contract changes.

- BRD: no change. The software-engineering workflow outcome remains the same.
- PRD: replace `prd.seqlane-on-mastra` with an engine-neutral product document. Preserve its non-engine product requirements.
- RFC: this RFC replaces the accepted Mastra runtime foundation; its acceptance records architecture authority, not code delivery.
- ADR: replace the workflow-engine and local-process decisions. Revise engine-opaque adapter and observability decisions.
- SPEC: the linked active target contract supersedes the engine-specific runtime contracts. Retained product semantics remain in force through that contract.
- TASK: create the linked delivery task with ordered vertical slices and deletion gates.

The former accepted Mastra RFC and engine-specific ADR/spec records are superseded by this accepted RFC and active target spec. Their engine-independent product requirements remain normative through explicit incorporation in the target spec until transferred to target-only owners by S12. The user authorized the full migration; implementation remains incomplete until each task slice has evidence.

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
Replace `compilePlanToMastra`, private envelopes, runtime composition, and the Promise scheduler with a thin Plan interpreter.
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

Illustrative lifecycle change, using proposed private helper names:

Before:

```ts
const execution = createMastraPlanExecution(options);
try {
  return await execution.runtime.run(request);
} finally {
  await execution.runtime.shutdown();
}
```

After:

```ts
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const execution = yield* acquirePlanExecution(options);
  return yield* execution.run(request);
}).pipe(Effect.scoped, Effect.withSpan("seqlane.run"));

// Only the Oclif or direct-call boundary evaluates the program.
return Effect.runPromise(program.pipe(Effect.provide(RunLive)));
```

The helper and layer names describe the target design. This example is not compiled implementation evidence.
`acquirePlanExecution` registers cleanup during acquisition, including partial acquisition failure.

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

Replace private engine response shapes in `operational-client.ts` with protocol-owned Zod DTOs.
Retain useful existing endpoint paths where possible; do not expose or recreate the previous framework API wholesale.
Inventory each consumed endpoint before removal. The target contract defines the required operations.

Use a fresh versioned hosted database, such as `.seqlane/operations.db`.
Never open the old database as the new schema or delete it automatically.
Existing history remains in its original file; in-place conversion and old-history import are outside this migration.
Document this intentional history discontinuity. New hosted runs must remain inspectable after restart.
Mark unfinished runs interrupted after host loss; do not replay side effects.

## Architecture and boundaries

Every package has an explicit disposition. “Audit” includes source, dependencies, tests, exports, documentation, and build output.

| Package path                            | Migration disposition                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/core`                             | Keep DSL, Plan, identity, Zod, and public Promise callbacks. Remove engine language and strengthen public-boundary tests                                   |
| `libs/protocol`                         | Keep canonical Zod schemas, serialization, versioning, observation semantics, and malformed-input checks. Own new operational DTOs                         |
| `libs/runtime`                          | Replace engine compilation, envelopes, execution, local processes, host, storage, telemetry, and duplicate lifecycle code with Effect                      |
| `libs/adapter`                          | Keep one generic capability contract. Convert private orchestration to Effect; remove engine-context obligations after projection callers migrate          |
| `libs/opencode`                         | Keep native SDK/harness. Scope connections, streams, checkpoints, forks, repair attempts, and cleanup; replace native trace projection                     |
| `libs/codex`                            | Keep native app-server transport. Migrate connection, stream, request, cancellation, and process lifetimes; preserve observation availability              |
| `libs/acp`                              | Replace `@mastra/acp` with the official ACP SDK client. Preserve ACP v1 negotiation, permissions, model selection, output repair, and capability reporting |
| `libs/tui`                              | Keep Ink/React and pure reducers. Migrate stream subscription/disposal where needed; preserve complete values and passive terminal behavior                |
| `libs/fixtures`                         | Replace engine fixtures with portable workflow fixtures and reusable Effect test services                                                                  |
| `libs/action-code-review`               | Execute through the common Effect program. Migrate I/O and cancellation; preserve pure review state, publication limits, and exact write confirmation      |
| `libs/action-merge-conflict-resolution` | Migrate agent runner, workspace/process operations, and cancellation; remove old observation forwarding                                                    |
| `libs/action-service-lifecycle`         | Scope service acquisition, readiness, teardown, and bounded retries for its real Action consumers                                                          |
| `apps/cli`                              | Effect command/application orchestration behind Oclif; runner supervision and output parity; host/replay/plan migration; launcher removal                  |
| `apps/docs`                             | Rewrite architecture, setup, operation, observability, and examples. Keep VitePress                                                                        |
| `workflows/code-review`                 | Preserve workflow behavior and Zod schemas. Migrate affected callback integration and verify review fixture results                                        |
| `workflows/read-context`                | Preserve behavior and Zod schemas. Verify deterministic and agent execution through Effect                                                                 |
| `workflows/resolve-merge-conflicts`     | Preserve workflow behavior, session/workspace policy, and schemas. Verify conflict-resolution fixtures                                                     |
| `actions/code-review`                   | Effect composition behind Actions SDK entry/post hooks; rebuild and inspect both bundles                                                                   |
| `actions/resolve-merge-conflicts`       | Same runtime and lifecycle migration; preserve Action inputs, outputs, and non-interactive behavior                                                        |
| `actions/opencode-server`               | Effect-backed lifecycle helper; preserve ready/owned-service/post-cleanup behavior                                                                         |
| `actions/ripwire-server`                | Same service lifecycle; preserve Zod input contract and transport behavior                                                                                 |
| `actions/zvec-grep-server`              | Same service lifecycle; preserve transport, ownership, and cleanup                                                                                         |
| `actions/setup-opencode`                | Scope download/cache/tool operations behind Effect; preserve Actions SDK and Zod input contract                                                            |

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

`effect@4.0.5` passes the Snyk package/version check for known direct issues at planning time.
This is not a transitive dependency audit.
Scoped-package pages were partly unavailable or stale. Companion packages and the ACP SDK require fresh exact-version checks before installation.
No dependencies were installed or changed for this plan.

## Migration or rollout

Deliver the vertical slices in the linked task. Start with one real CLI-to-process-to-observation path.
Each slice names its base, observable evidence, replaced callers, and deletion condition.
No release ships a permanent engine selector, fallback path, or dual write.

Rollback uses the previous complete commit/release, not a fallback engine.
Use additive hosted schema migrations during development and keep old databases untouched.
Do not promote a failed tracer or infer readiness from document status.

The final cleanup includes this document's before examples, inventory names, legacy paths, and traceability links.
Transfer retained contracts into target-only documents before removing obsolete canonical records.
Then remove or rewrite migration records and replace legacy stable IDs in all relationships.
The user's complete-removal requirement takes precedence over the usual policy of retaining superseded engine documents in the tracked tree.
History remains recoverable through Git.

## Open questions

No product-scope question blocks this plan. Oclif and public/wire Zod are explicit constraints.
Exact companion package versions and platform termination behavior are implementation verification gates, not assumed results.
The proposed Studio removal and fresh hosted-history format are explicit behavior changes for review.

## Delivery state

Architecture accepted and target contract active. No runtime, CLI, dependency, or migration delivery is claimed by this document.
The first tracer and all runtime evidence remain pending.

## Traceability

- [brd.seqlane: Business requirements](../brd/2026-09-02-seqlane.md)
- [prd.seqlane-runtime: Product requirements](../prd/2026-10-21-seqlane-runtime.md)
- [Superseded product requirements](../prd/2026-09-03-seqlane-on-mastra.md)
- [Current runtime foundation](./2026-09-03-mastra-runtime-and-operational-foundation.md)
- [Current workflow contracts](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
- [Standalone CLI contract](../specs/2026-09-16-standalone-cli-runs.md)
- [Engine-opaque adapter boundary](../adrs/2026-09-18-engine-opaque-agent-adapter-contracts.md)
- [Observation target contract, retained for later reconciliation](../specs/2026-09-19-otel-aligned-observation-contract.md)
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
