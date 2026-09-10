---
id: task.seqlane-action-workflow-migration
title: Migrate the Merge Conflict Workflow to the Seqlane Action
status: completed
owners:
  - core
created: 2026-09-06
updated: 2026-09-08
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Migrate the Merge Conflict Workflow to the Seqlane Action

## Objective

Replace the direct resolver shell implementation with the bundled Seqlane
Action. Preserve the manual workflow interface, trust boundary, and operator
behavior.

## Upstream requirements

Implement `requirement-workflow-host` and all workflow-facing acceptance
criteria from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

Depend on:

- [task.seqlane-action-resolution-controller](./2026-09-06-seqlane-action-resolution-controller.md)
- [task.seqlane-action-entrypoint-and-bundle](./2026-09-06-seqlane-action-entrypoint-and-bundle.md)

Follow [`.github/workflows/AGENTS.md`](../../../.github/workflows/AGENTS.md).

## Scope

- Keep the workflow name and manual dispatch inputs stable.
- Keep `rebase` as the default strategy.
- Keep default-branch dispatch protection.
- Keep workflow revision reporting.
- Keep the trusted source checkout at an explicit trusted revision.
- Keep the pull-request head checkout separate from trusted source.
- Keep full checkout history for merge bases and rebase operations.
- Invoke `uses: ./seqlane-source/actions/resolve-merge-conflicts` from the
  trusted source checkout.
- Pass `commit: true` and `push: true` explicitly.
- Pass the source and target directories explicitly.
- Keep required permissions, concurrency, runner, and timeout declarations.
- Remove the direct conflict loop from workflow YAML.
- Remove direct OpenCode installation and lifecycle shell steps.
- Remove direct lockfile regeneration shell steps.
- Remove direct staging, commit, and push shell steps.
- Keep only the bootstrap metadata needed before target checkout.
- Update `examples/README.md` with the Action-based operator flow.
- Update the example contract test to stop asserting implementation shell text.
- Remove production references to the old helper after the cutover.

## Out of scope

- New pull-request triggers.
- Fork support.
- Squash support.
- Changes to the generic conflict-resolution workflow.
- Changes to GitHub permissions beyond the current required permissions.
- Changes to OpenCode policy or model selection.

## Implementation plan

1. Add the Action invocation after the trusted and target checkouts.
2. Pass the captured pull-request number and selected strategy.
3. Pass `source-directory` and `target-directory` as workspace-relative paths.
4. Pass explicit `commit` and `push` values.
5. Remove each migrated shell section only after its Action behavior has a
   focused test.
6. Keep the bootstrap PR metadata step until the checkout sequence no longer
   requires it.
7. Verify that the workflow never checks out or imports pull-request source as
   trusted Seqlane source.
8. Keep `persist-credentials: false` until the Action enables authentication
   for the final push phase.
9. Update operator documentation for the secret, strategy, permissions,
    commit behavior, push guard, and failure cases.
10. Remove the old helper script only after `rg` finds no production reference.

Keep the workflow text focused on GitHub job composition. Do not replace the
removed shell with a new large shell block.

## Affected areas

- `.github/workflows/seqlane-resolve-merge-conflicts.yml`
- `examples/README.md`
- `apps/seqlane-cli/src/resolve-merge-conflicts-example.spec.ts`
- `scripts/resolve-merge-conflicts-workflow.test.ts`
- `libs/action-merge-conflict-resolution/src/workspace-boundary.ts`
- generated Action bundle and workflow tests

## Verification

Run these checks:

```text
pnpm run test:mapping
pnpm exec nx run action-resolve-merge-conflicts:typecheck
pnpm exec nx run action-resolve-merge-conflicts:build
git diff --exit-code -- actions/*/dist/
pnpm docs:validate
pnpm format:check
git diff --check
```

Inspect the final workflow for these conditions:

- default branch guard remains present
- full-history checkouts remain present
- trusted source and target paths remain separate
- required permissions remain minimal
- concurrency remains per pull request
- local Action invocation is present
- direct rebase, lockfile, OpenCode, staging, commit, and push loops are gone.

Run the manual workflow on a disposable same-repository pull request. Test both
strategies and inspect the final remote branch state.

## Completion criteria

- The workflow still accepts the same manual inputs.
- A clean merge does not create a merge commit.
- A clean rebase pushes only when history changes.
- Mixed conflicts resolve through the Action and not through YAML shell.
- Lockfile-only conflicts do not start OpenCode.
- The Action stops before push when the base or head changes.
- The Action uses the exact force-with-lease expectation.
- Operator documentation matches the final workflow.
- The old helper script has no production reference.

## Outcome

Completed. The manual resolver workflow now keeps the default-branch guard,
pull-request bootstrap, full-history trusted and target checkouts, minimal
permissions, per-pull-request concurrency, Ubuntu runner, and 30-minute
timeout. It invokes `./seqlane-source/actions/resolve-merge-conflicts` with
explicit source and target paths plus `commit: true` and `push: true`. The YAML no longer owns
integration, conflict classification, OpenCode, lockfile, staging, commit, or
push loops, and operator documentation describes the Action contract and trust
model.

The former helper script was removed after its focused tests moved to the
private Action library. The production workflow has no reference to the old
helper.

Verification passed for the updated workflow contract test, `pnpm run
test:mapping`, `pnpm docs:validate`, `pnpm format:check`, and
`git diff --check`. Hosted GitHub execution remains required to verify the
manual dispatch, checkout permissions, credentials, and remote race behavior.

A subsequent successful GitHub-hosted workflow run is available at [run
34163697786](https://github.com/marcolink/seqlane/actions/runs/34163697786).
This is additional hosted evidence. It does not replace the manual scenario
matrix or prove every remote race and permission condition in the completion
criteria.

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- Prior task: [task.resolve-pull-request-merge-conflicts](./2026-09-04-resolve-pull-request-merge-conflicts.md)
