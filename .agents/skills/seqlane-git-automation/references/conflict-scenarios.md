# Git Conflict Scenarios

Use this reference when implementing or testing merge, rebase, cherry-pick, or conflict-resolution behavior.

## Principles

- Use the real Git CLI as the source of truth.
- Test conflict behavior against temporary repositories rather than mocked Git output.
- Treat conflicts as an expected Git outcome, not an unexpected process failure.
- Do not detect conflicts only by searching files for conflict markers.
- Do not parse human-readable or potentially localized Git output when plumbing or porcelain output is available.
- Preserve repository state that was not created by the current operation.

## Outcome model

Distinguish successful integration, conflicts, and operational failures:

```ts
type GitIntegrationResult =
  | {
      outcome: "clean";
      operation: "merge" | "rebase" | "cherry-pick";
      headBefore: string;
      headAfter: string;
    }
  | {
      outcome: "conflicted";
      operation: "merge" | "rebase" | "cherry-pick";
      headBefore: string;
      conflicts: GitConflict[];
    }
  | {
      outcome: "failed";
      operation: "merge" | "rebase" | "cherry-pick";
      headBefore: string;
      exitCode: number;
      stderr: string;
    };

type GitConflict = {
  path: string;
  kind:
    | "content"
    | "both-added"
    | "both-deleted"
    | "added-by-us"
    | "added-by-them"
    | "deleted-by-us"
    | "deleted-by-them"
    | "rename"
    | "binary"
    | "file-directory"
    | "submodule"
    | "unknown";
  stages: {
    base?: string;
    ours?: string;
    theirs?: string;
  };
};
```

The exact types may follow existing repository conventions, but the implementation must preserve the distinction between:

1. A completed operation.
2. An operation paused by conflicts.
3. A failure unrelated to conflicts.

## Conflict detection

Use the unmerged index as the authoritative conflict source:

```bash
git ls-files --unmerged -z
```

Unmerged index stages are:

| Stage | Meaning    |
| ----: | ---------- |
|   `1` | Merge base |
|   `2` | Ours       |
|   `3` | Theirs     |

A stage can be absent for add/delete conflicts.

For a concise status representation, use:

```bash
git status --porcelain=v2 -z
```

Do not rely only on:

```bash
git status
```

Human-readable status output may change and is less suitable for deterministic parsing.

### Short-status conflict codes

When porcelain v1 is used, Git may report:

| Code | Meaning         |
| ---- | --------------- |
| `DD` | Both deleted    |
| `AU` | Added by us     |
| `UD` | Deleted by them |
| `UA` | Added by them   |
| `DU` | Deleted by us   |
| `AA` | Both added      |
| `UU` | Both modified   |

Use index stages for the underlying data. Status codes should primarily support classification and presentation.

### “Ours” and “theirs”

The meaning of ours and theirs depends on the operation.

During a regular merge:

- Ours is the currently checked-out branch.
- Theirs is the commit or branch being merged.

During a rebase, Git internally replays commits onto the new base. User-facing expectations around ours and theirs can therefore appear reversed.

Do not build resolution logic around the labels alone. Preserve:

- The operation type.
- The original branch.
- The target commit.
- The merge base.
- The index stages.

## Required test scenarios

Implement the scenarios relevant to the supported operations.

| ID        | Scenario                                            | Expected result                                                    |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `GIT-C01` | Clean merge                                         | Operation completes without unmerged entries                       |
| `GIT-C02` | Same-line content conflict                          | `UU` conflict with stages 1, 2, and 3                              |
| `GIT-C03` | Different-line changes                              | Git merges automatically                                           |
| `GIT-C04` | Both added with different content                   | `AA` conflict with stages 2 and 3                                  |
| `GIT-C05` | Ours modified, theirs deleted                       | Modify/delete conflict                                             |
| `GIT-C06` | Ours deleted, theirs modified                       | Delete/modify conflict                                             |
| `GIT-C07` | File renamed on one side and modified on the other  | Rename/modify conflict or automatic merge, depending on similarity |
| `GIT-C08` | Same file renamed differently on both sides         | Rename/rename conflict                                             |
| `GIT-C09` | Binary file changed on both sides                   | Binary conflict without usable inline markers                      |
| `GIT-C10` | File added where the other side creates a directory | File/directory conflict                                            |
| `GIT-C11` | Repository has unrelated uncommitted changes        | Operation refuses to start or preserves them                       |
| `GIT-C12` | Integration is already applied                      | Idempotent no-change result                                        |
| `GIT-C13` | Detached HEAD                                       | Behavior follows the operation’s documented support                |
| `GIT-C14` | Shallow clone lacks required history                | Structured operational failure or explicit history fetch           |
| `GIT-C15` | Remote advances before push                         | Push is rejected without force                                     |
| `GIT-C16` | Conflict is resolved but not staged                 | Operation remains conflicted                                       |
| `GIT-C17` | Conflict is resolved and staged                     | No unmerged index entries remain                                   |
| `GIT-C18` | Conflict markers remain as intentional text         | Index state, not marker search, determines resolution state        |

Submodule, Git LFS, case-only rename, symlink, and file-mode scenarios are required only when the product explicitly supports them.

## Creating deterministic fixtures

Create a fresh temporary repository for every test.

Configure it locally:

```bash
git init --initial-branch=main
git config user.name "Seqlane Test"
git config user.email "test@seqlane.local"
git config commit.gpgsign false
git config core.autocrlf false
```

Use the filesystem API to create fixture files and invoke Git with argument arrays. Avoid executing interpolated shell scripts in tests.

### Content conflict fixture

Create this history:

```text
base
├── ours
└── theirs
```

Fixture procedure:

1. Create and commit `file.txt` on `main`.
2. Create branch `ours`.
3. Change the same line and commit.
4. Return to the base commit.
5. Create branch `theirs`.
6. Change the same line differently and commit.
7. Check out `ours`.
8. Merge `theirs`.

Expected state:

- Merge exits non-zero.
- `git ls-files --unmerged -z` reports `file.txt`.
- Stages 1, 2, and 3 exist.
- The repository has an active merge operation.

Locate merge state through Git rather than assuming `.git` is a directory:

```bash
git rev-parse --git-path MERGE_HEAD
```

This also works correctly with linked worktrees.

### Modify/delete fixture

1. Commit `file.txt` on the base branch.
2. Modify and commit it on `ours`.
3. Delete and commit it on `theirs`.
4. Merge `theirs` into `ours`.

Assert the missing index stage in addition to the displayed status classification.

### Binary conflict fixture

1. Commit a binary fixture.
2. Change its bytes differently on both branches.
3. Merge the branches.
4. Assert the unmerged index entries.

Do not expect conflict markers in the working-tree file.

### Remote race fixture

Use a temporary bare repository as `origin` and two independent clones:

```text
origin.git
├── worker-clone
└── competing-clone
```

1. Both clones start at the same remote commit.
2. The worker creates a local commit.
3. The competing clone pushes another commit.
4. The worker attempts to push.
5. Assert that the push is rejected.
6. Assert that no force-push was attempted.

## Assertions

Prefer assertions against repository state over log wording.

Useful commands include:

```bash
git rev-parse HEAD
git rev-parse --verify MERGE_HEAD
git status --porcelain=v2 -z
git ls-files --unmerged -z
git diff --name-only --diff-filter=U -z
git diff --cached --name-status -z
git merge-base <ours> <theirs>
```

Depending on the scenario, assert:

- Exit code.
- HEAD before and after the operation.
- Existence of operation state.
- Unmerged paths.
- Available index stages.
- Working-tree contents.
- Staged contents.
- Commit parents.
- Remote ref after a push.
- Preservation of unrelated changes.

Avoid assertions based solely on exact stderr wording.

## Operation ownership and cleanup

An implementation may abort only an operation that it started.

Before beginning an operation, capture:

```ts
type RepositorySnapshot = {
  head: string;
  branch?: string;
  status: string;
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  cherryPickInProgress: boolean;
};
```

If a merge, rebase, or cherry-pick was already in progress, return a structured precondition failure unless continuing that operation was explicitly requested.

Do not automatically run:

```bash
git reset --hard
git clean -fd
git checkout -- .
```

To abandon an operation started by the current execution, use the corresponding Git command:

```bash
git merge --abort
git rebase --abort
git cherry-pick --abort
```

After aborting, verify that:

- HEAD matches the captured starting commit.
- Operation state no longer exists.
- Unrelated pre-existing changes remain intact.

## Resolution lifecycle

Use the following lifecycle for automated conflict resolution:

1. Capture the initial repository state.
2. Start the Git operation.
3. Detect unmerged entries through the index.
4. Collect base, ours, and theirs for every conflict.
5. Produce semantic resolutions.
6. Write resolved files.
7. Stage resolved paths explicitly.
8. Verify that no unmerged index entries remain.
9. Run mechanical validation.
10. Review the staged diff.
11. Complete the Git operation.
12. Run repository verification.
13. Push only when explicitly enabled.

A file is resolved from Git’s perspective only after the appropriate result has been staged:

```bash
git add -- <path>
```

For a resolved deletion:

```bash
git rm -- <path>
```

Do not use `git add --all` until the implementation has verified that doing so cannot stage unrelated changes.

## Mechanical validation

Do not run formatters against files that still contain unresolved index entries.

After semantic resolution:

1. Verify that the unmerged index is empty.
2. Run the repository’s required formatter on affected files.
3. Re-stage formatter changes.
4. Run `git diff --check`.
5. Run relevant linting, type-checking, and tests.
6. Inspect the final staged diff before committing.

Formatting must not be treated as conflict resolution. It occurs after the semantic result has been selected.

Searching for conflict markers can be used as a supplemental warning:

`<<<<<<<`, `=======`, `>>>>>>>`

It must not be the authoritative resolution check because:

- Binary conflicts have no textual markers.
- Modify/delete conflicts may have no markers.
- Marker-like text may be intentional content.
- Custom merge drivers can produce different working-tree results.

## Completing operations

For a merge, verify the resulting commit has the expected parents.

For a rebase, verify:

- The expected commits were replayed.
- The branch points at the new history.
- No rebase state remains.

For a cherry-pick, verify:

- The selected commit was applied.
- No cherry-pick state remains.

Do not create a commit when there are no staged changes unless an empty commit was explicitly requested.

## Push behavior

Keep conflict resolution, committing, and pushing as separate decisions.

Before pushing:

1. Verify the current branch and remote.
2. Fetch the latest remote state when required.
3. Confirm the intended destination ref.
4. Use a normal push.
5. Treat non-fast-forward rejection as a recoverable remote race.

Do not automatically force-push.

If history rewriting is explicitly part of the workflow, prefer:

```bash
git push --force-with-lease
```

The expected remote commit used by the lease must be known and verified. Never fall back from `--force-with-lease` to an unconditional force-push.

## Definition of done

Conflict-handling behavior is complete when:

- Clean integration and every supported conflict category have real-repository tests.
- Conflicts are detected through the Git index.
- Expected conflicts are distinguished from operational failures.
- Resolution requires staging.
- Unrelated worktree changes are preserved.
- Abort behavior restores only state created by the current operation.
- Mechanical verification runs after semantic resolution.
- Remote races do not cause an unconditional force-push.
- Tests do not depend on localized human-readable Git output.
