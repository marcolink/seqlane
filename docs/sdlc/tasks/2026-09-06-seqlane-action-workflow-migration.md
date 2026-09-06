---
id: task.seqlane-action-workflow-migration
title: Migrate the Merge Conflict Workflow to the Seqlane Action
status: planned
owners:
  - core
created: 2026-09-06
updated: 2026-09-06
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
- Invoke `uses: ./actions/resolve-merge-conflicts`.
- Pass `commit: true` and `push: true` explicitly.
- Pass the source and target directories explicitly.
- Keep required permissions, concurrency, runner, and timeout declarations.
- Remove the direct conflict loop from workflow YAML.
- Remove direct OpenCode installation and lifecycle shell steps.
- Remove direct lockfile regeneration shell steps.
- Remove direct staging, commit, and push shell steps.
- Keep only the bootstrap metadata needed before target checkout.
- Update `test-actions.yml` for the new Action contract.
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
9. Update the Action test workflow without adding remote mutations.
10. Update operator documentation for the secret, strategy, permissions,
    commit behavior, push guard, and failure cases.
11. Remove the old helper script only after `rg` finds no production reference.

Keep the workflow text focused on GitHub job composition. Do not replace the
removed shell with a new large shell block.

## Affected areas

- `.github/workflows/seqlane-resolve-merge-conflicts.yml`
- `.github/workflows/test-actions.yml`
- `examples/README.md`
- `apps/seqlane-cli/src/resolve-merge-conflicts-example.spec.ts`
- `scripts/resolve-merge-conflicts-workflow.ts`
- `scripts/resolve-merge-conflicts-workflow.test.ts`
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

Planned.

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- Prior task: [task.resolve-pull-request-merge-conflicts](./2026-09-04-resolve-pull-request-merge-conflicts.md)
