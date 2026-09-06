---
id: task.seqlane-action-resolution-controller
title: Compose the Seqlane Action Resolution Controller
status: completed
owners:
  - core
created: 2026-09-06
updated: 2026-09-06
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Compose the Seqlane Action Resolution Controller

## Objective

Compose the typed ports into one resolution controller. Preserve the current
merge, rebase, staging, empty-commit, commit, and push behavior.

## Upstream requirements

Implement `requirement-conflict-attempts`, `requirement-rebase-continuation`,
and `requirement-commit-and-push` from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

Depend on:

- [task.seqlane-action-resolution-contracts](./2026-09-06-seqlane-action-resolution-contracts.md)
- [task.seqlane-action-git-workspace-boundary](./2026-09-06-seqlane-action-git-workspace-boundary.md)
- [task.seqlane-action-runtime-adapters](./2026-09-06-seqlane-action-runtime-adapters.md)

## Scope

- Add the application controller.
- Validate the request before any target mutation.
- Validate default-branch dispatch context.
- Obtain and validate pull-request metadata.
- Capture the live base revision.
- Start the selected merge or rebase operation.
- Handle clean integration without starting agent work.
- Handle conflict sets through the attempt state machine.
- Run the agent only for non-lockfile conflict files.
- Regenerate the lockfile only when required.
- Validate, stage, and continue the operation after each attempt.
- Skip empty rebase commits when the worktree and index are clean.
- Stop after the configured attempt limit.
- Create the merge commit only when commit permission is enabled.
- Verify remote base and head revisions before a push.
- Use the exact force-with-lease expectation.
- Stop runtime processes before push authentication.
- Return bounded structured results.
- Preserve per-attempt recording.

## Out of scope

- Action Toolkit calls.
- Workflow triggers and permissions.
- New conflict-resolution task prompts.
- OpenCode permission policy changes.
- New GitHub comment, check, or label behavior.

## Implementation plan

1. Capture a repository snapshot before the operation starts.
2. Reject a pre-existing merge or rebase state.
3. Resolve the pull request and live base revision once per Action run.
4. Start integration with the selected strategy.
5. Return `no-change` for a clean merge.
6. Return `no-change` when a rebase already contains the base revision.
7. Mark a clean rebase that changes history as requiring a push.
8. For every conflict stop, refresh the conflict set from Git.
9. Pass the complete conflict set to validation and staging.
10. Pass only non-lockfile paths to the agent runner.
11. Regenerate the lockfile in a new temporary workspace when needed.
12. Validate changed paths before staging.
13. Stage the original conflict set with NUL-safe path input.
14. Reject unresolved index entries before continuation.
15. Run cached whitespace and marker checks.
16. Continue a merge by entering the commit phase.
17. Continue a rebase with `GIT_EDITOR=true git rebase --continue`.
18. Handle an empty commit with `git rebase --skip` only when the worktree and
    index are clean.
19. Stop if the rebase state becomes inconsistent.
20. Stop agent and container processes in `finally` paths.
21. Commit and push only after all guards pass.
22. Return a result that contains captured revisions, attempt count, and push
    state without secret or raw executor data.

Keep commit and push as separate controller decisions. Do not hide a remote
write inside the workspace or Git adapter.

## Affected areas

- `libs/action-merge-conflict-resolution/src/resolution-controller.ts`
- `libs/action-merge-conflict-resolution/src/commit-and-push.ts`
- `libs/action-merge-conflict-resolution/src/summary.ts`
- `libs/action-merge-conflict-resolution/src/index.ts`
- colocated controller tests
- temporary repository integration tests

## Verification

Run these checks:

```text
pnpm run test:mapping
pnpm exec nx run action-merge-conflict-resolution:test
pnpm exec nx run action-merge-conflict-resolution:typecheck
pnpm format:check
git diff --check
```

Use real temporary repositories for:

- clean merge
- clean rebase with changed history
- content conflict
- lockfile-only conflict
- mixed agent and lockfile conflicts
- repeated rebase conflict stops
- empty commit after resolution
- changed base before push
- changed head before push
- exact lease rejection.

Assert HEAD, branch refs, operation state, index stages, staged paths, commit
parents, remote refs, and process cleanup.

## Completion criteria

- The controller has no shell command strings.
- The controller does not inspect human-readable Git output.
- Clean integration, conflict pauses, empty commits, and operational errors
  remain distinct.
- Every conflict attempt follows the specified action order.
- The controller never pushes when `push` is false.
- The controller never uses unconditional force push.
- The controller stops runtime processes before GitHub authentication.
- Remote races stop the run without overwriting the remote branch.
- The controller returns deterministic results for all terminal states.

## Outcome

Completed. Added the typed resolution controller and commit/push adapter. The
controller validates the request and pull-request preflight, reads the live
base revision, follows the conflict-attempt order, separates agent and
lockfile work, validates and stages only the original conflict set, continues
rebases, and enforces the attempt limit. Commit and push remain separate. The
commit adapter sets identity only in the target repository, verifies fetched
base and head revisions, and uses the required force-with-lease refspec.

Verification passed for the dependent TypeScript build, 51 focused tests,
`pnpm run test:mapping`, `pnpm docs:index`, `pnpm docs:validate`,
`pnpm docs:test`, `pnpm format:check`, and `git diff --check`.

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
