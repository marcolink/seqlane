---
name: seqlane-git-automation
description: Implement or review automated Git operations in Seqlane, including status inspection, commits, pushes, merges, rebases, patches, and conflict handling.
---

# Seqlane Git Automation

Use the real Git CLI as the source of repository semantics.

## Interface

- Execute commands using argument arrays.
- Always provide an explicit working directory.
- Return structured command results containing exit code, stdout, and stderr.
- Do not treat every non-zero exit code as an unexpected exception.
- Do not interpolate branch names, paths, commit messages, or event data into
  shell commands.

## Responsibilities

Use Git CLI operations for:

- repository state;
- diffs and patches;
- branches and refs;
- merges and rebases;
- conflict detection;
- staging and commits;
- fetching and pushing.

Use GitHub APIs for:

- pull-request metadata;
- comments and reviews;
- checks and statuses;
- labels;
- repository permissions;
- remote branch metadata where no working tree is involved.

## Mutations

- Inspect the current repository state before mutating it.
- Preserve unrelated user changes.
- Configure commit identity locally rather than globally.
- Keep modification, commit, and push as distinct operations.
- Require explicit authorization before pushing or rewriting remote history.
- Never silently discard or reset unresolved work.

## Verification

Test Git behavior against temporary real repositories.

Read
[references/conflict-scenarios.md](references/conflict-scenarios.md)
when implementing merge or rebase behavior.
