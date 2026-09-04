---
id: task.resolve-pull-request-merge-conflicts
title: Resolve Pull Request Merge Conflicts
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-05
upstream: []
supersedes: []
---

# Resolve Pull Request Merge Conflicts

## Objective

Add a Seqlane example and a manual GitHub Actions workflow that resolve merge
conflicts for an open pull request.

## Upstream requirements

No active specification owns this repository-automation example. Preserve the
public Seqlane contracts and the executor-neutral workflow-authoring boundary.

## Scope

- Add a Seqlane workflow that edits only the supplied conflict files.
- Add a `workflow_dispatch` workflow that accepts a pull-request number.
- Require a dispatch choice between `rebase` and `merge`, with `rebase` as
  the default.
- Accept only open pull requests with a head branch in this repository.
- Apply the selected integration strategy to the current base and head
  revisions.
- Run the Seqlane workflow only when Git reports merge conflicts, in a fresh
  non-Git staging workspace that contains only regular conflict files.
- Make sure that all conflicts are resolved before a commit and push.
- Reject unexpected workspace edits and concurrent head-branch changes.
- Reject staged conflict markers, including CRLF, diff3, and longer marker
  lines, and bound rebase conflict-resolution attempts.
- Verify the pinned OpenCode archive before extraction.
- Add contract tests and operator documentation.

## Out of scope

- Automatic runs for pull-request events.
- Fork pull requests.
- Squash behavior.
- Changes to public Seqlane contracts or runtime permission contracts.
- Automatic conflict resolution without a manual dispatch.

## Implementation plan

1. Define bounded input and output schemas for the conflict-resolution example.
2. Define one exclusive agent task with explicit file-edit limits.
3. Add contract tests for input validation, task policy, and model selection.
4. Add the manual GitHub Actions workflow, strategy selection, and repository
   safety gates.
5. Document the dispatch behavior, credentials, commit, and push rules.

## Affected areas

- `examples/resolve-merge-conflicts.ts`
- `apps/seqlane-cli/src/resolve-merge-conflicts-example.spec.ts`
- `.github/workflows/seqlane-resolve-merge-conflicts.yml`
- `examples/README.md`
- `docs/sdlc/tasks/index.md`

## Verification

- Run the focused example contract test.
- Parse the GitHub Actions workflow as YAML.
- Inspect the dispatch, pull-request, edit-scope, and push-race gates.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run `git diff --check`.

## Completion criteria

- A maintainer can dispatch the workflow with a pull-request number.
- The workflow stops for a closed pull request or a fork pull request.
- The workflow validates the required strategy and defaults it to `rebase`.
- The workflow does not create a merge commit when a merge has no conflicts.
- Seqlane receives the current revisions and the exact conflict-file list.
- The agent can read and edit files, but it cannot use shell commands.
- The workflow rejects edits outside the initial conflict-file list.
- The workflow commits and pushes only after all conflicts are resolved.
- A rebased branch uses a force push protected by an exact remote-head lease.
- The workflow checks the base revision before it pushes. The exact lease
  prevents an unexpected remote-head update.
- The focused tests and documentation checks pass.

## Outcome

The repository now contains one Seqlane conflict-resolution example and one
manual GitHub Actions workflow. The workflow uses the code-review workflow as
its setup and trust-boundary blueprint.

The workflow accepts an open same-repository pull request. Dispatch requires a
choice between `rebase` and `merge`, and defaults that choice to `rebase`. It
applies the selected strategy to the captured base and head revisions. Seqlane
runs only when Git reports conflicts. The agent can read and edit files, but it
cannot use shell commands or external paths. It runs in a fresh non-Git staging
copy that contains only the conflict files. The workflow rejects symlinks, so
the agent cannot write Git metadata or escape the staging boundary.

After the agent finishes, the workflow rejects unexpected edits, new files,
unresolved conflicts, and whitespace errors. A rebase can stop at more than
one conflicting commit. The workflow repeats the agent resolution for each
stop, up to five attempts, and skips redundant empty commits. It rejects
conflict-marker lines after staging, including CRLF, diff3, and longer marker
lines. The
workflow validates paths in the resolution checkout, including ignored
untracked paths. It stops OpenCode before GitHub authentication.

The workflow downloads a pinned OpenCode release archive and checks its
SHA-256 before extraction. It checks the base revision before a push. The exact
force-with-lease check prevents an unexpected remote-head update. A base update
after the check can make the result stale, but it cannot overwrite the base
branch.

The focused tests, full test suite, build, type checks, lint, formatting, YAML
parse, SDLC checks, and Git diff check pass. Lint reports two existing warnings
in `apps/seqlane-studio/src/client/app/main.tsx`.

## Traceability

This task is implementation-only. It has no upstream SDLC document.
