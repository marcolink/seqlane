---
id: spec.direct-runtime-code-review-action
title: Direct Runtime Code-Review Action Integration
status: active
owners:
  - core
created: 2026-09-08
updated: 2026-09-24
upstream:
  - adr.direct-runtime-code-review-action
  - adr.runner-built-action-bundles
  - spec.effect-runtime-integration
  - spec.dedicated-runner-process
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Direct Runtime Code-Review Action Integration

## Summary

Replace the inline CLI-based code-review job with a Node 24 JavaScript Action.
The Action runs a trusted, bundled Seqlane review workflow through the direct
runtime service. It keeps GitHub admission and service lifecycle composition in
the workflow.

This specification defines the new runtime and Action boundary. The active
[Versioned Pull Request Review Comments](./2026-09-05-versioned-pull-request-review-comments.md)
spec remains authoritative for review state, finding lifecycle,
metrics ledger, publication order, bounds, trust, and marker semantics.

## Goals

- Provide a runner-independent runtime service for trusted applications.
- Keep `seqlane run` on a fresh dedicated runner process.
- Build the code-review Action from trusted source before local invocation.
- Move review application behavior into `libs/action-code-review`.
- Express deterministic review transformations as typed Seqlane tasks.
- Keep GitHub I/O behind narrow Action-library ports and adapters.
- Preserve current review behavior and security boundaries.
- Prove direct runtime invocation without the CLI wrapper.

## Non-goals

- Change the public Plan, event, executor, or workflow-authoring contracts.
- Replace or supersede `adr.dedicated-runner-process`.
- Create a generic Action framework, scheduler, or GitHub support library.
- Move service startup or cleanup out of the existing service Actions.
- Execute pull-request code, tests, builds, scripts, or checks.
- Change pull-request permissions or concurrency policy.
- Define a new review-state or publication model.

## Terminology

- **Trusted workflow:** A workflow object loaded or built from the trusted
  Action bundle.
- **Review target:** The untrusted pull-request checkout used for bounded Git
  evidence.
- **Direct runtime service:** `startWorkflowRun`, without runner IPC or CLI
  presentation.
- **Action library:** The private `libs/action-code-review` package.
- **Service Action:** An existing Action that owns one external service and
  its startup and post cleanup.
- **Authoritative report:** The trusted bot comment defined by
  `spec.versioned-pull-request-review-comments`.

## Requirements

### requirement-direct-runtime-service

`@seqlane/runtime` must expose `startWorkflowRun` as an application-facing
service. The service must accept these explicit inputs:

- a trusted `BuiltWorkflow` containing its workflow definition, Plan, task
  definitions, and validator definitions;
- candidate workflow input, which the service validates with the workflow's
  input schema;
- the existing `RuntimeProfileReference`, including the explicit review-target
  workspace path;
- a Seqlane event sink;
- an optional caller-owned `AbortSignal`; and
- an optional Seqlane-owned runtime-session notification callback.

A caller can also supply one complete Work and Run identity pair. The service
must reject an incomplete pair and allocate a fresh pair when the caller omits
it. It must allocate Invocation identities internally. It must return an
active-run handle that exposes the Work and Run identities, an idempotent
cancellation operation, and a typed outcome using existing Seqlane result and
error contracts. The service must perform runtime-profile resolution, Plan
compilation, model and session preflight, execution, event emission,
cancellation, and outcome mapping.

The service must not accept a workflow path, module specifier, dynamic import,
runner host, IPC message, CLI renderer, or process-exit callback. It must not
expose Effect values, Effect error types, resolved executor or session
registries, runner-host types, or CLI types.

`startRun` must remain a thin runner adapter. It owns workflow loading,
identity allocation, IPC event forwarding, runner-control mapping, and runner
exit. `startRunnerProcess` retains IPC request decoding and signal handling.
`startRun` passes the loaded workflow, runtime-profile reference, input, and
allocated identities to the direct service. It must call the direct service
for runtime-profile resolution and the shared execution lifecycle.

### requirement-trusted-bundled-workflow

The code-review Action must load or build its workflow only from statically
bundled trusted Action source. The workflow must be included in the Action
bundle or in a private library entry point that the bundle includes.

The Action must not dynamically import a workflow from the review target. It
must not use a review-target path as executable module input. The consumer
workflow must install and build only its explicit trusted source checkout.

The main and post bundles must be self-contained runtime outputs generated by
one cacheable Nx task before local Action invocation. Bundle-loading tests must
prove that `dist/main.js` and `dist/post.js` load from trusted Action source and
its declared dependencies. The outputs must not be committed.

### requirement-action-library-boundary

Create `libs/action-code-review` as a private Action-specific library. The
directory name must not use the `seqlane-` prefix. The package must contain
review application contracts, Zod validation, typed errors, review policy,
ports, adapters, orchestration, and tests.

Create `actions/code-review` as a thin Node 24 JavaScript Action entrypoint.
The entrypoint adapts Action inputs, outputs, logging, and failure handling to
the library. The library must run without an Actions Toolkit environment.

The package must reuse suitable ports, adapters, Zod schemas, typed errors,
and bundle patterns from `libs/action-merge-conflict-resolution`. It must not
become a generic Action, GitHub, runtime, Git, or lifecycle support package.

### requirement-workflow-composition

The workflow must retain these concerns:

- event triggers and admission checks;
- pull-request permissions and per-pull-request concurrency;
- runner and timeout selection;
- trusted workflow-revision checkout;
- untrusted review-target checkout with full history;
- composition of setup-opencode, opencode-server, zvec-grep-server, and
  ripwire-server Actions; and
- the existing closed-pull-request cancellation job.

The workflow must call the code-review Action after checkout and service setup.
It must pass only the explicit pull-request identity, base and head revisions,
review-target path, OpenCode URL, and GitHub token that the Action needs. The
OpenCode server configuration remains the integration point for zvec-grep and
Ripwire. The code-review Action must not receive their endpoints or credentials
unless a later contract gives it direct responsibility for those services. The
workflow must not contain the review task graph, CLI invocation, event replay,
metrics derivation, report rendering, GitHub publication, or marker cleanup
shell implementation.

The service Actions retain external service startup, readiness, process
identity, and post cleanup. The code-review Action must not stop or delete
their processes.

### requirement-seqlane-task-ownership

Store the portable review graph in `workflows/code-review/`, with one primary
concern per file. Keep workflow authoring
executor-neutral and keep GitHub, Action Toolkit, OpenCode, and service types
out of Plan and DSL contracts.

New code-review Plans use the `code-review` workflow ID and `code-review-*`
task IDs. This is the directory-era identity convention. Existing persisted
Plans, recordings, and metrics retain their historical IDs and remain
self-describing; no runtime identifier translation occurs. Consumers must
treat workflow and task IDs as opaque historical values.

Use two trusted, statically bundled Seqlane workflows. The review workflow
must use typed tasks for:

- deterministic review-context normalization;
- bounded Git evidence collection;
- prior-state reconciliation;
- review task fanout, synthesis, and finalization;
- fixed-claim verification.

After the review run reaches a terminal outcome and its event sink flushes, a
model-free publication workflow must consume the frozen review result and a
frozen Action-private metric projection derived from canonical events. The
projection retains only task identity/status, run status, heartbeat duration,
and invocation metrics; raw inputs, outputs, activity payloads, and transcripts
must not cross into publication. It must use typed local tasks for:

- metrics derivation;
- report rendering; and
- live-state checks, publication decisions, and publication.

This two-workflow boundary lets metrics include the review run's terminal event
without exposing a mutable event sink to the running review workflow. All pure
deterministic tasks and all publication-workflow tasks must make zero model
calls. Side-effecting local tasks must use injected task-local ports and
adapters. The task registry can capture those ports, but the Plan and task data
must not contain GitHub clients, credentials, or platform types.

Tasks must not own service startup, service cleanup, admission, concurrency,
checkout, permissions, or target-code execution. The Action main and post
entrypoints must own the marker failure shield because it must cover failures
that occur before either workflow starts.

### requirement-publication-and-cleanup

The Action must own review metadata and context collection after checkout,
trusted prior-state parsing, the in-progress marker lifecycle, direct Seqlane
execution, event collection, metrics derivation, bounded rendering, stale-write
checks, final publication, Action outputs, and marker cleanup.

The Action must use narrow ports for GitHub reads and writes. Before every
publication write, it must apply the live pull-request, trusted-author,
reviewed-head, same-head run identity, and open or eligible checks from
`spec.versioned-pull-request-review-comments`.

The marker must include an owning run identity. The Action must remove its
marker after success, failure, or cancellation. Action metadata must define a
`post` entrypoint with `post-if: always()`. The main entrypoint must save the
bounded marker identity needed by the post entrypoint before review execution.
Main-path cleanup and post cleanup must be idempotent. Cleanup must refuse to
remove a marker owned by a newer run. A cleanup error must remain visible and
must not be hidden by a prior execution error.

The Action must derive the existing run metrics object from canonical Seqlane
events. It must keep missing provider metrics absent, preserve bounded state,
and publish one authoritative report and metrics ledger according to the
active review-comment spec.

### requirement-behavior-preservation

The migration must preserve the active review-comment contract, including:

- trusted bot identity and strict state validation;
- bounded comments, history, findings, verification, and state;
- no pull-request code, tests, builds, scripts, or checks execution;
- stable finding identifiers and lifecycle status;
- current-head verification of retained findings;
- deterministic verdict, severity, status, and limitation rendering;
- one run metrics ledger with idempotent run identity;
- stale-write checks for revision and same-head run ordering;
- in-progress marker cleanup on all terminal paths; and
- isolated review-target Git evidence.

The direct service must preserve existing Seqlane event order, event payloads,
run outcomes, executor inputs, and cancellation behavior. The CLI path must
retain its current observable behavior after it delegates to the service.

### requirement-verification

Verification must prove the direct service and Action boundaries. It must
include test mapping before focused suites, focused runtime and Action tests,
review workflow tests, typecheck, build, lint, bundle loading, YAML validation,
Action lint when available, documentation validation, and `git diff --check`.

Verification must include a GitHub-hosted manual workflow run that invokes the
bundled Action without the CLI wrapper. The run must prove trusted and target
checkout separation, service Action composition, direct Seqlane execution,
publication or stale-write behavior, bounded outputs, and service post
cleanup.

## Detailed design or contracts

### Direct service contract

The application-facing contract uses the following conceptual types. The
implementation must use the repository's existing public event and outcome
types and the narrowest existing runtime dependency types:

```ts
interface StartWorkflowRunRequest<Input, Output> {
  workflow: BuiltWorkflow<Input, Output>
  input: JsonValue
  runtime: RuntimeProfileReference
  events: SeqlaneEventSink
  signal?: AbortSignal
  identity?: { readonly workId: string; readonly runId: string }
  onRuntimeSessionUi?: (
    notification: RuntimeSessionUiAvailable,
  ) => void | Promise<void>
}

interface WorkflowRunHandle {
  readonly workId: string
  readonly runId: string
  readonly outcome: Promise<SeqlaneRunOutcome>
  cancel(): Promise<void>
}

function startWorkflowRun<Input, Output>(
  request: StartWorkflowRunRequest<Input, Output>,
): WorkflowRunHandle
```

These names describe the contract. The implementation must reuse the existing
`BuiltWorkflow`, `RuntimeProfileReference`, event, and outcome types. It must
define only the small request and handle types that are missing.
`BuiltWorkflow` contains no module path or loader callback. `JsonValue` keeps
the existing runner input contract. The service must parse `input` through the
trusted workflow input schema before runtime-profile resolution or task work.
These types must not expose Effect, resolved runtime registries, IPC,
runner-host, GitHub, or CLI presentation types. The optional runtime-session
callback uses a Seqlane-owned notification type and does not expose its runner
IPC encoding.

Compilation and preflight failures must return the existing typed failed
outcome and preserve the original cause. Cancellation before execution must
produce one cancelled outcome and no task work. Cancellation during execution
must interrupt active work through the existing `AbortSignal` contract and
must not map interruption to failure. Repeated cancellation must be safe and
must not emit duplicate terminal events.

### Action input and output contract

The Action metadata must define these exact inputs:

- `github-token`;
- `repository`;
- `pull-request-number`;
- `review-target`;
- `base-branch`;
- `base-revision`;
- `head-revision`;
- `runtime` for the OpenCode runtime URL.

The trusted workflow must be a static dependency of the Action bundle. The
Action must collect prior review history through its GitHub port. It must not
accept workflow source or prior review history from the review target. The
entrypoint must validate all input and GitHub context data with Zod and must
mask the GitHub token before logs or summaries.

The Action must publish only the bounded outputs needed by the workflow:
`verdict`, `reviewed-revision`, `work-id`, `run-id`, and
`publication-status`. Outputs must not contain credentials, raw transcripts,
metrics ledgers, unbounded review state, or Effect or runner objects.

### Execution and publication sequence

```text
workflow admission and checkout
        ↓
service Actions start and expose endpoints
        ↓
code-review Action reads and validates context
        ↓
Action marks trusted report in progress
        ↓
Action builds bundled trusted workflow input
        ↓
Action calls startWorkflowRun directly
        ↓
Action freezes the review result and an Action-private metric projection of the canonical events
        ↓
Action runs the model-free publication workflow directly
        ↓
publication tasks derive metrics, render, check live state, and publish or skip
        ↓
Action removes only its own marker on the main path
        ↓
Action post entrypoint performs idempotent always-run cleanup
        ↓
service Actions run their own post cleanup
```

The Action must keep review-target paths explicit. It must pass bounded Git
evidence as data. It must not pass a review-target module path to the runtime
service or to a dynamic importer.

## Failure and edge cases

- If input or trusted workflow validation fails, fail before model work.
- If runtime preflight fails, emit the existing typed failed outcome.
- If cancellation arrives before task work, emit one cancelled outcome.
- If cancellation arrives during a task, preserve executor abort behavior.
- If an event sink fails, preserve the original failure cause and fail the run.
- If publication sees a changed head, skip the stale write or fail according
  to the active review-comment contract; do not publish stale state.
- If a newer run owns the marker, leave that marker unchanged.
- If main-path marker cleanup fails, save enough bounded state for the Action
  post entrypoint to retry it and report the failure.
- If a service Action fails, let its own lifecycle and post hook report the
  failure. The code-review Action must not perform service cleanup.
- If an ineligible event reaches the job, do not start review execution.

## Migration

Replace the inline review application steps in
`.github/workflows/seqlane-code-review.yml` with the local code-review Action.
Delete the workflow's Seqlane dependency installation, CLI build, `seqlane run`
invocation, CLI replay, inline metric calculation, inline report rendering,
inline publication, and separate marker cleanup implementation.

Retain the trusted source checkout because it supplies and builds the local
Action. Retain the untrusted review-target checkout and all service Action
composition. Keep permissions, concurrency, timeout, and closed-pull-request
cancellation. Admit eligible pull-request events in the review job and do not
subscribe to issue comments.

Keep the review graph and its typed task modules in `workflows/code-review/`.
Keep GitHub publication and Action orchestration in the Action consumer. Keep
the CLI workflow test as a runner-adapter compatibility test, and add direct
service and Action tests for the consumer path.

## Verification

- Run the test-mapping check before focused tests.
- Run focused `seqlane-runtime`, `action-code-review`, and code-review example
  tests, including malformed input and cancellation cases.
- Run runtime and Action typecheck, build, lint, and bundle-loading tests.
- Parse the workflow and Action metadata, and run `actionlint` when available.
- Run `pnpm docs:index`, `pnpm docs:validate`, and documentation tests.
- Run formatting checks and `git diff --check`.
- Run the GitHub-hosted manual workflow proof for direct Action invocation.
- Record Ripwire limitations: affected-edge analysis does not model YAML,
  callbacks, or dynamic edges. Keep focused CLI review tests and workflow
  invariants in the verification gate.

## Acceptance criteria

- `startWorkflowRun` runs a trusted built workflow without runner IPC or CLI
  presentation types.
- `startRun` delegates shared execution to the service and retains fresh-runner
  behavior.
- `actions/code-review` runs from a self-contained Node 24 bundle built from
  the trusted workflow revision before local invocation.
- `libs/action-code-review` owns review application behavior and narrow I/O
  adapters without becoming a generic support package.
- The workflow retains trust, permissions, concurrency, checkout, service
  composition, timeout, and closed-event behavior, with one review job for
  eligible pull-request events and manual dispatch.
- The review Action preserves the active review-comment contract and cleans
  up only its own marker after every terminal path through main and post
  entrypoints.
- The model-free publication workflow derives metrics from the frozen review
  event list and performs rendering, stale-write checks, and publication with
  zero model calls.
- Deterministic Seqlane tasks make zero model calls.
- The direct invocation test and GitHub-hosted manual run prove that the Action
  does not call the CLI wrapper or execute review-target code.
- Mapping, focused tests, typecheck, build, lint, bundle loading, YAML or
  Action lint, documentation validation, and diff checks pass or record a
  repository limitation.

## Traceability

- Packaging: [adr.runner-built-action-bundles](../adrs/2026-09-11-runner-built-action-bundles.md)

- [adr.direct-runtime-code-review-action](../adrs/2026-09-08-direct-runtime-code-review-action.md)
- [adr.effect-private-runtime-engine](../adrs/2026-09-02-effect-private-runtime-engine.md)
- [adr.dedicated-runner-process](../adrs/2026-09-02-dedicated-runner-process.md)
- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- [adr.executor-neutral-workflow-authoring](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [adr.autonomous-non-interactive-execution](../adrs/2026-09-02-autonomous-non-interactive-execution.md)
- [spec.effect-runtime-integration](./2026-09-02-effect-runtime-integration.md)
- [spec.dedicated-runner-process](./2026-09-02-dedicated-runner-process.md)
- [spec.versioned-pull-request-review-comments](./2026-09-05-versioned-pull-request-review-comments.md)
- [task.deliver-direct-runtime-code-review-action](../tasks/2026-09-08-deliver-direct-runtime-code-review-action.md)
- [task.simplify-pull-request-review-triggers](../tasks/2026-09-24-simplify-pull-request-review-triggers.md)
