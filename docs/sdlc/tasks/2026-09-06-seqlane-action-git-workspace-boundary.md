---
id: task.seqlane-action-git-workspace-boundary
title: Build the Seqlane Action Git and Workspace Boundary
status: completed
owners:
  - core
created: 2026-09-06
updated: 2026-09-06
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Build the Seqlane Action Git and Workspace Boundary

## Objective

Move Git operations and conflict workspace safety rules into the Action
library. Preserve the existing typed helper behavior and extend it with the
Git index model required by the specification.

## Upstream requirements

Implement `requirement-git-integration`, `requirement-agent-workspace`, and
`requirement-target-validation` from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

Depend on [task.seqlane-action-resolution-contracts](./2026-09-06-seqlane-action-resolution-contracts.md).

Use the Git rules in [seqlane-git-automation](../../../.agents/skills/seqlane-git-automation/SKILL.md),
including real Git integration tests and argument-array execution.

## Scope

- Add a Git port with structured command results.
- Add a Node Git adapter that uses `execFile` or the repository subprocess
  convention with argument arrays.
- Add explicit working-directory handling for every Git command.
- Add clean, conflicted, and operational-error integration results.
- Parse the unmerged index with a NUL-safe Git command.
- Add precondition checks for existing merge, rebase, and unrelated worktree
  state.
- Move bounded path checks from `scripts/resolve-merge-conflicts-workflow.ts`.
- Reject path traversal and symlinks in every path component.
- Accept only regular files for the agent workspace.
- Enforce 512 KiB per-file and 2 MiB total agent bounds.
- Reject binary agent files.
- Clear only the temporary agent workspace owned by the current run.
- Copy back only allowlisted conflict paths.
- Reject changed tracked, untracked, and ignored paths outside the allowlist.
- Stage only the original conflict set.
- Add staged whitespace and marker validation.
- Keep the old script as a thin temporary wrapper until migration is complete.

## Out of scope

- GitHub API calls.
- Docker lockfile regeneration.
- OpenCode or Seqlane execution.
- Commit and push orchestration.
- Action metadata or workflow YAML.

## Implementation plan

1. Inspect the existing helper and list each exported behavior before moving
   it.
2. Define a Git adapter result that distinguishes a clean operation from a
   conflict and from an unrelated Git error.
3. Use `git ls-files --unmerged -z` as the conflict source.
4. Preserve the operation type, starting revision, target revision, conflict
   paths, and index stages in the result.
5. Use Git plumbing and NUL-safe output for paths.
6. Reject a pre-existing operation before the controller starts one.
7. Move `prepareAgentWorkspace`, `copyAgentEdits`, and the lockfile input file
   bounds into the library workspace module.
8. Keep lockfile input preparation separate from agent input preparation.
9. Make the marker expression supplemental. Do not use it as the conflict
   authority.
10. Test merge, rebase, modify/delete, binary, symlink, path traversal, and
    unexpected-file cases with temporary repositories.

Do not use shell command strings. Do not use `git reset --hard`, `git clean
-fd`, or an unconditional force push as recovery.

## Affected areas

- `libs/action-merge-conflict-resolution/src/git-port.ts`
- `libs/action-merge-conflict-resolution/src/git-cli.ts`
- `libs/action-merge-conflict-resolution/src/workspace-boundary.ts`
- `libs/action-merge-conflict-resolution/src/marker-validation.ts`
- `libs/action-merge-conflict-resolution/src/index.ts`
- colocated unit and Git integration tests
- `scripts/resolve-merge-conflicts-workflow.ts`
- `scripts/resolve-merge-conflicts-workflow.test.ts`

## Verification

Run the focused checks before the full suite:

```text
pnpm run test:mapping
pnpm exec nx run action-merge-conflict-resolution:test
pnpm run test:workflow-helper
pnpm exec nx run action-merge-conflict-resolution:typecheck
pnpm format:check
git diff --check
```

Use a new temporary repository for each Git scenario. Assert repository state,
index entries, staged paths, worktree paths, commit parents, and operation
state. Do not assert only human-readable Git output.

## Completion criteria

- All old helper behavior has a library implementation.
- Git conflicts come from the unmerged index.
- Expected Git conflicts do not become generic process errors.
- The workspace rejects traversal, symlinks, binary files, oversized files,
  unexpected edits, and unexpected untracked paths.
- Staging uses the original conflict allowlist.
- Staged whitespace and marker checks remain active.
- Temporary repository tests cover the supported conflict categories.
- The old helper has no duplicate policy implementation.

## Outcome

Completed. Moved Git integration, unmerged-index parsing, workspace path and
payload guards, lockfile input preparation, target validation, and staged
whitespace/marker checks into the private Action library. The existing helper
remains a thin compatibility wrapper, and real temporary-repository tests
cover clean and conflicted merge/rebase states, modify/delete and binary
conflicts, staging, unrelated changes, and workspace safety boundaries.

Verification passed for `pnpm run test:mapping`, the package typecheck and
build, the package suite (28 tests), `pnpm run test:workflow-helper`,
`pnpm docs:validate`, `pnpm format:check`, and `git diff --check`. The helper
now builds the private library before its strip-only Node test and imports it
through the declared workspace package export.

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- Prior helper: [`scripts/resolve-merge-conflicts-workflow.ts`](../../../scripts/resolve-merge-conflicts-workflow.ts)
