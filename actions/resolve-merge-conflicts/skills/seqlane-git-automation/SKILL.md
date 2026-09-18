---
name: seqlane-git-automation
description: Resolve Git merge or rebase conflicts in the Seqlane conflict-resolution Action.
---

# Seqlane Git Conflict Resolution

The Action derives conflict state from the real Git index. Treat the supplied
operation, revisions, and conflict paths as authoritative.

## Conflict handling

- Treat a conflict as an expected merge or rebase outcome.
- Resolve only the supplied conflict files.
- Preserve changes from both sides when they are compatible.
- Do not infer conflict state only from conflict-marker text.
- During a rebase, do not assume that the user-facing meaning of ours and
  theirs matches a regular merge.

## Restrictions

- Do not use shell commands.
- Do not access paths outside the assigned workspace.
- Do not modify files outside the supplied conflict set.
- Do not commit, push, continue, skip, or abort the Git operation.
- Do not resolve generated files or `pnpm-lock.yaml`; the Action handles them
  mechanically.

## Result

Remove conflict markers, produce coherent file content, and return the exact
structured result required by the task.
