---
id: task.deliver-direct-runtime-code-review-action
title: Deliver the Direct-Runtime Code-Review Action
status: planned
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.direct-runtime-code-review-action
  - spec.versioned-pull-request-review-comments
supersedes: []
---

# Deliver the Direct-Runtime Code-Review Action

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
  review event list, renders the report, checks live state, and publishes or
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
   first. Freeze its result and canonical events, then run the model-free
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
- The model-free publication workflow consumes a frozen event list and makes
  zero model calls.
- Existing review behavior remains covered by focused tests and the hosted
  manual proof.
- Main-path and always-run post cleanup remove only the marker owned by the
  current run.
- The committed bundle, documentation, type indexes, and validation checks are
  synchronized.

## Outcome

Not started. This task is planned for implementation.

## Traceability

- [spec.direct-runtime-code-review-action](../specs/2026-09-08-direct-runtime-code-review-action.md)
- [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md)
- [adr.direct-runtime-code-review-action](../adrs/2026-09-08-direct-runtime-code-review-action.md)
- [task.seqlane-action-runtime-adapters](./2026-09-06-seqlane-action-runtime-adapters.md)
- [task.seqlane-action-entrypoint-and-bundle](./2026-09-06-seqlane-action-entrypoint-and-bundle.md)
