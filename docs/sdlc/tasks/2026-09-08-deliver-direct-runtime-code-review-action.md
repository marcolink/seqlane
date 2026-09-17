---
id: task.deliver-direct-runtime-code-review-action
title: Deliver the Direct-Runtime Code-Review Action
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-17
upstream:
  - spec.direct-runtime-code-review-action
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Deliver the Direct-Runtime Code-Review Action

Historical path note: `examples/pr-code-review.ts` was superseded by `workflows/code-review/workflow.ts`; `examples/README.md` by `workflows/README.md`.

## Objective

Migrate the trusted code-review workflow from inline YAML and CLI execution to
a self-contained Node 24 Action that calls `startWorkflowRun` directly. Keep
the current review behavior and active review-comment contract.

## Upstream requirements

- Follow [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md).
- Preserve [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md).
- Apply [adr.direct-runtime-code-review-action](../adrs/2026-09-08-direct-runtime-code-review-action.md).
- Keep [adr.dedicated-runner-process](../adrs/2026-09-02-dedicated-runner-process.md)
  for `seqlane run`.

## Scope

- Extract and export the runner-independent `startWorkflowRun` service from
  `libs/seqlane-runtime`.
- Make the service accept a trusted `BuiltWorkflow`, validate its input, and
  resolve the existing runtime-profile reference internally.
- Keep `startRun` as a thin IPC adapter over the direct service.
- Create private `libs/action-code-review` contracts, ports, adapters,
  orchestration, typed tasks, and focused tests.
- Add `actions/code-review` metadata, thin Node 24 main and post entrypoints,
  committed self-contained bundles, and bundle-drift verification.
- Reorganize `examples/pr-code-review.ts` into cohesive review workflow and
  task/library files.
- Move context normalization, bounded Git evidence, prior-state reconciliation,
  fanout, synthesis, finalization, and fixed verification into the typed review
  workflow.
- Add a model-free publication workflow that derives metrics from the frozen
  Action-private metric event projection, renders the report, checks live state, and publishes or
  records a stale-write skip through typed local tasks.
- Replace the inline review implementation in
  `.github/workflows/seqlane-code-review.yml` with the local Action.
- Delete the superseded inline dependency install, CLI build, CLI run, replay,
  metric, rendering, publication, and marker-cleanup path.
- Update examples documentation and canonical SDLC indexes.

## Out of scope

- Changes to pull-request admission, permissions, concurrency, checkout trust,
  timeout, or closed-event cancellation policy.
- Changes to setup-opencode, opencode-server, zvec-grep-server, or
  ripwire-server lifecycle implementation.
- A generic Action framework, scheduler, GitHub support package, or service
  lifecycle package.
- Changes to Plan IR, public workflow authoring, runner IPC, event schemas,
  executor contracts, or the active review-comment state model.
- Execution of pull-request code, tests, builds, scripts, or checks.

## Implementation plan

1. Inspect current runtime, Action, review example, workflow, and test
   contracts. Record unrelated worktree changes before edits.
2. Define the direct runtime service contract and extract shared profile
   resolution, compilation, preflight, execution, event, cancellation, and
   outcome behavior.
3. Add runtime tests for trusted workflow input, preflight failures,
   cancellation, event sink failures, and CLI-adapter parity.
4. Split the review example and add the private Action-library contracts,
   Zod schemas, typed errors, ports, adapters, and typed review and publication
   workflows.
5. Add the Action main and always-run post entrypoints and metadata. Build and
   commit both self-contained bundles. Add bundle-drift, marker-cleanup, and
   direct-invocation tests.
6. Move workflow application behavior into the Action. Run the review workflow
   first. Freeze its result and the Action-private metric projection, then run the model-free
   publication workflow. Keep marker cleanup at the Action lifecycle boundary.
7. Keep the GitHub workflow's admission, checkout, service Actions,
   permissions, concurrency, timeout, and closed-event job.
8. Add review regression tests for trust, bounds, no target-code execution,
   stale writes, metrics, dispositions, and marker cleanup.
9. Update examples and SDLC documentation. Run the required verification gates
   in the order defined by the active spec.

## Affected areas

- `libs/seqlane-runtime/src/`
- `libs/action-code-review/`
- `actions/code-review/`
- `examples/pr-code-review.ts` and reorganized owned files
- `apps/seqlane-cli/src/pr-code-review-example.spec.ts`
- `.github/workflows/seqlane-code-review.yml`
- `examples/README.md`
- `docs/sdlc/adrs/`
- `docs/sdlc/specs/`
- `docs/sdlc/tasks/`
- `docs/sdlc/adrs/index.md`
- `docs/sdlc/specs/index.md`
- `docs/sdlc/tasks/index.md`

## Verification

- Run `pnpm test:mapping` before focused test suites.
- Run focused runtime, Action-library, Action-entrypoint, and code-review
  example tests, including malformed input and cancellation tests.
- Run runtime and Action typecheck, build, lint, and formatting checks.
- Build the Action main and post bundles and run the bundle-drift and
  bundle-runtime tests.
- Parse the workflow and Action metadata, and run `actionlint` when available.
- Run `pnpm docs:index`, `pnpm docs:validate`, and `pnpm docs:test`.
- Run `git diff --check`.
- Run the GitHub-hosted manual workflow proof without the CLI wrapper. Verify
  trusted and target checkout separation, service startup and post cleanup,
  direct runtime execution, publication or stale-write handling, and bounded
  Action outputs.
- Include focused CLI review tests and workflow invariants because Ripwire's
  affected analysis does not model YAML, callbacks, or dynamic edges.

## Completion criteria

- The runtime service and Action contracts match the active SPEC.
- `startRun` retains fresh-runner behavior and delegates shared lifecycle work.
- The code-review Action uses only trusted bundled workflow source and does not
  call the CLI or runner.
- The Action accepts only the GitHub, pull-request, review-target, revision,
  and OpenCode inputs that its contract requires.
- The workflow contains composition and admission only for review application,
  while service lifecycle remains with its service Actions.
- The Action library owns typed review tasks and narrow GitHub adapters.
- The model-free publication workflow consumes a frozen metric event projection and makes
  zero model calls.
- Existing review behavior remains covered by focused tests and the hosted
  manual proof.
- Main-path and always-run post cleanup remove only the marker owned by the
  current run.
- The committed bundle, documentation, type indexes, and validation checks are
  synchronized.

## Outcome

Implemented and committed the local migration in three reviewable slices:

- `8d7075a` documents the accepted ADR, active specification, and delivery
  task.
- `cdc9194` adds the direct `startWorkflowRun` runtime service and makes the
  runner adapter delegate shared execution to it.
- `b833297` adds the bundled Node 24 code-review Action, the private review
  and publication workflows, trusted GitHub ports, Action post cleanup, and
  workflow migration.

The direct Action path, runner compatibility tests, Action bundle smoke and
drift checks, and focused test mapping checks passed locally. The required
GitHub-hosted manual workflow proof passed in [run
34406526570](https://github.com/marcolink/seqlane/actions/runs/34406526570).
PR #83 merged as `804aeae`, and that merge commit is reachable from the
current `main` target.

The full repository test run reached and passed the new runtime and Action
projects, but stopped on the pre-existing
`actions/resolve-merge-conflicts` bundle-drift check. The full typecheck is
also blocked by existing strict-fixture errors in untouched portions of the
code-review and merge-conflict test suites. The migration-local type errors
found during that run were corrected before this record was updated.

Follow-up review hardening is committed in `83efda7`
(`refactor(runtime): share direct-run internals`) and `345ed06`
(`fix(actions): harden review publication`). The runtime now owns the shared
agent-work and runtime-profile helpers. The Action validates repository input
with a schema, rejects malformed GitHub metadata, bounds disposition history,
validates frozen publication data, preserves newer same-head reports, and
keeps rendered reports within the publication limit. Focused test mapping,
runtime tests, Action-library tests, Action typecheck, bundle smoke and drift,
and SDLC validation passed after those commits.

[PR #83](https://github.com/marcolink/seqlane/pull/83) further hardens the
Action before merge. It bounds newest-first GitHub comment retrieval and event
retention, requires complete frozen publication identity, retains the latest
40 metrics-ledger runs, preserves required report markers within the UTF-8
publication limit, and re-reads the authoritative report immediately before
publication. Focused Action-library tests, Action typecheck, bundle smoke and
drift, and test mapping passed locally. The GitHub-hosted manual workflow
proof remains pending.

Follow-up review hardening is committed in `e10044c`
(`fix(actions): harden review feedback`). The Action now serializes retained
Seqlane errors before its frozen publication snapshot, evicts bounded events in
constant time by priority, reuses the initial bounded history to find the prior
report, and neutralizes model-controlled URLs and Markdown link or image
syntax. Focused Action-library tests, Action typecheck, test mapping, and the
committed-bundle smoke and drift check passed locally.

Further review hardening is committed in `adbe2ad`
(`fix(actions): harden review execution`). The runtime now preserves a typed
terminal outcome when its event sink continues to fail. The Toolkit-free Action
library owns review and publication lifecycle orchestration, while the
entrypoint only adapts inputs, GitHub clients, outputs, and top-level errors.
Metrics derivation now indexes retained invocation events linearly without
changing the existing output-total semantics. Focused runtime and Action-library
tests, Action typecheck, test mapping, and the committed-bundle smoke and drift
check passed locally.

The publication snapshot now retains an Action-private metric projection rather
than full canonical event payloads. It keeps only task/run lifecycle and
measured metrics, so review-history bodies, tool payloads, and transcripts do
not introduce a second publication-size constraint.

## Traceability

- [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md)
- [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- [adr.direct-runtime-code-review-action](../adrs/2026-09-08-direct-runtime-code-review-action.md)
- [task.seqlane-action-runtime-adapters](./2026-09-06-seqlane-action-runtime-adapters.md)
- [task.seqlane-action-entrypoint-and-bundle](./2026-09-06-seqlane-action-entrypoint-and-bundle.md)
