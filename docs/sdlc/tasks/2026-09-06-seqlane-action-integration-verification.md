---
id: task.seqlane-action-integration-verification
title: Verify the Seqlane Action Merge Conflict Resolver
status: in-progress
owners:
  - core
created: 2026-09-06
updated: 2026-09-08
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Verify the Seqlane Action Merge Conflict Resolver

## Objective

Prove that the migrated Action preserves resolver behavior, safety controls,
bundle integrity, workflow structure, and documentation traceability.

## Upstream requirements

Verify every requirement in
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

Run this task after the implementation tasks complete:

- [task.seqlane-action-resolution-contracts](./2026-09-06-seqlane-action-resolution-contracts.md)
- [task.seqlane-action-git-workspace-boundary](./2026-09-06-seqlane-action-git-workspace-boundary.md)
- [task.seqlane-action-runtime-adapters](./2026-09-06-seqlane-action-runtime-adapters.md)
- [task.seqlane-action-resolution-controller](./2026-09-06-seqlane-action-resolution-controller.md)
- [task.seqlane-action-entrypoint-and-bundle](./2026-09-06-seqlane-action-entrypoint-and-bundle.md)
- [task.seqlane-action-workflow-migration](./2026-09-06-seqlane-action-workflow-migration.md)

## Scope

- Run test mapping before scoped tests.
- Run pure contract and policy tests.
- Run temporary repository Git integration tests.
- Run Action adapter tests with fixture GitHub context.
- Run lockfile and workspace bound tests.
- Run the production workflow's trusted local Action through
  `uses: ./seqlane-source/actions/resolve-merge-conflicts`.
- Run `actionlint` against all workflow files.
- Run the local Action smoke workflow with `act` when Docker is available.
- Keep `act` runs free of push credentials and remote mutations.
- Verify the committed Action bundle.
- Parse and inspect the migrated workflow.
- Run the manual workflow against a disposable same-repository pull request.
- Test both `rebase` and `merge` strategies.
- Test a clean integration path.
- Test an agent conflict path.
- Test a lockfile-only conflict path.
- Test a mixed conflict path.
- Test an empty rebase commit.
- Test a remote base race.
- Test a remote head race.
- Run all required repository checks.
- Update unresolved SDLC traceability before completion.

## Out of scope

- Permanent remote test branches.
- Fork pull-request support.
- Automatic conflict resolution triggers.
- Changes to the product requirements.

## Implementation plan

1. Run `pnpm run test:mapping`.
2. Run the focused Action library and Action tests.
3. Run each required temporary repository scenario.
4. Inspect index state and remote refs after every mutating scenario.
5. Run the Action bundle build.
6. Run `git diff --exit-code -- actions/*/dist/`.
7. Run the hosted production workflow.
8. Parse the migrated workflow and inspect permissions, checkouts, concurrency,
   and Action invocation.
9. Run the manual workflow on a disposable pull request.
10. Confirm that the final remote branch matches the expected merge or rebase
    result.
11. Confirm that a changed base or head stops the push.
12. Run documentation index and validation commands.
13. Run formatting, type, test, lint, build, and Git diff checks.
14. Record any remaining limitation in the specification or task outcome.

## Affected areas

- Action library test files
- Action adapter test files
- Git integration fixtures
- `.github/workflows/seqlane-resolve-merge-conflicts.yml`
- `docs/sdlc/adrs/index.md`
- `docs/sdlc/specs/index.md`
- `docs/sdlc/tasks/index.md`

## Verification

Run:

```text
pnpm run test:mapping
pnpm exec nx run action-merge-conflict-resolution:test
pnpm exec nx run action-resolve-merge-conflicts:typecheck
pnpm exec nx run action-resolve-merge-conflicts:build
git diff --exit-code -- actions/*/dist/
actionlint
pnpm docs:index
pnpm docs:validate
pnpm docs:test
pnpm format:check
pnpm typecheck
pnpm test
pnpm lint
pnpm build
git diff --check
```

Do not mark this task complete when only unit tests pass. The Git and Action
integration layers are part of the acceptance evidence.

The `act` result is supplemental evidence. A GitHub-hosted workflow run is
required for permissions, token behavior, checkout trust, and remote race
verification.

## Completion criteria

- All specification requirements have test evidence.
- Required Git scenarios pass against real temporary repositories.
- The local Action runs through `uses`.
- The Action bundle has no drift.
- The production workflow has no migrated resolver shell implementation.
- The manual workflow succeeds for clean and conflicted disposable pull
  requests.
- Remote races stop the push safely.
- Documentation indexes and validators pass.
- The final task outcomes record the verification commands and any known
  limitations.

## Outcome

Local verification for the Action migration is complete. The focused resolver
suite passes 51 tests across 13 files, including temporary-repository Git
scenarios, workspace and lockfile boundaries, controller ordering, remote
guard behavior, archive pin validation, and bounded recording. The CLI
workflow contract test passes, the test-to-implementation mapping passes, the
repository TypeScript build passes, Nx TypeScript sync is clean, scoped lint
passes with no warnings, the Action typecheck passes, and the minified bundle
is reproducible from source.

SDLC indexing, validation, documentation tests, formatting, and diff checks
also pass. The production workflow contains only bootstrap, trusted and
target checkouts, and the trusted local Action invocation.

A successful GitHub-hosted workflow run is available at [run
34163697786](https://github.com/marcolink/seqlane/actions/runs/34163697786).

Completion evidence remains unrecorded for the full manual scenario matrix,
remote base and head races, and `actionlint` and `act` checks where applicable.
The task remains in progress until its own completion criteria record those
results. Local checks and the hosted run do not replace that evidence. The
repository-wide Nx `test`, `lint`, and `build` commands remain blocked by the
shared external Nx workspace-data lock path.

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- Delivery: [task.seqlane-action-workflow-migration](./2026-09-06-seqlane-action-workflow-migration.md)
