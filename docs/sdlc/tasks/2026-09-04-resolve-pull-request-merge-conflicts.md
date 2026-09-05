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
  non-Git staging workspace that contains only regular agent-resolvable
  conflict files.
- Gate Seqlane and OpenCode setup on the presence of agent-resolvable conflicts.
- Exclude `pnpm-lock.yaml` from model resolution and regenerate it mechanically
  in an isolated temporary workspace when it is conflicted.
- Pin the lockfile regeneration toolchain and bound its package-manifest inputs.
- Centralize conflict workspace and staged-content validation in a typed helper.
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
4. Add the manual GitHub Actions workflow, strategy selection, repository
   safety gates, isolated mechanical lockfile regeneration, and typed workflow
   boundary helpers.
5. Document the dispatch behavior, credentials, commit, and push rules.

## Affected areas

- `examples/resolve-merge-conflicts.ts`
- `apps/seqlane-cli/src/resolve-merge-conflicts-example.spec.ts`
- `.github/workflows/seqlane-resolve-merge-conflicts.yml`
- `scripts/resolve-merge-conflicts-workflow.ts`
- `scripts/resolve-merge-conflicts-workflow.test.ts`
- `examples/README.md`
- `docs/sdlc/tasks/index.md`

## Verification

- Run the focused example contract test.
- Run the workflow boundary helper test.
- Parse the GitHub Actions workflow as YAML.
- Inspect the dispatch, pull-request, edit-scope, and push-race gates.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run `git diff --check`.

## Completion criteria

- A maintainer can dispatch the workflow with a pull-request number.
- The workflow stops for a closed pull request or a fork pull request.
- The workflow validates the required strategy and defaults it to `rebase`.
- The workflow does not create a merge commit when a merge has no conflicts.
- Seqlane receives the current revisions and the exact agent-resolvable
  conflict-file list. The complete Git conflict list remains the workflow-owned
  staging and validation allowlist.
- Lockfile-only conflicts do not require OpenAI credentials, Seqlane
  installation, or OpenCode startup.
- Lockfile regeneration excludes conflicted lockfile input, uses bounded inputs,
  and pins the Node and pnpm toolchain.
- Boundary validation is implemented by one checked-in typed helper.
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
copy that contains only the agent-resolvable conflict files. The workflow
rejects symlinks, so the agent cannot write Git metadata or escape the staging
boundary. A conflicted `pnpm-lock.yaml` is excluded from model resolution and
regenerated mechanically in an isolated temporary workspace for that rebase
stop. The temporary workspace contains no conflicted lockfile, accepts at most
64 package manifests, and limits each file to 512 KiB and the total input to 2
MiB. Docker uses a pinned Node image, Corepack activates pnpm 10.33.0 without
reading the project-selected package manager, and pnpm uses the npm registry.
The agent, OpenCode, and OpenAI credential steps run only when the current
conflict set contains an agent-resolvable file.

After the agent finishes, the workflow rejects unexpected edits, new files,
unresolved conflicts, and whitespace errors. A rebase can stop at more than
one conflicting commit. The workflow repeats the agent resolution for each
stop, up to ten conflict-resolution attempts, and skips redundant empty
commits. It regenerates a conflicted lockfile without involving the model and
gives each regeneration a fresh temporary workspace. The checked-in typed
workflow helper owns the canonical path, symlink, regular-file, size,
workspace, and staged-content
validation. It rejects conflict-marker lines after staging,
including CRLF, diff3, and longer marker lines. The
workflow validates paths in the resolution checkout, including ignored
untracked paths. It stops OpenCode before GitHub authentication.

The review hardening is recorded in commit `69d0215` and proposed in [PR
#46](https://github.com/marcolink/seqlane/pull/46).


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
