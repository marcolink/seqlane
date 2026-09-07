---
id: spec.seqlane-action-merge-conflict-resolution
title: Seqlane Action Merge Conflict Resolution
status: active
owners:
  - core
created: 2026-09-06
updated: 2026-09-07
upstream:
  - adr.seqlane-action-library-boundary
  - adr.executor-neutral-workflow-authoring
  - adr.autonomous-non-interactive-execution
  - adr.local-mechanical-tasks
  - adr.dedicated-runner-process
supersedes: []
---

# Seqlane Action Merge Conflict Resolution

## Summary

Move merge-conflict resolver behavior from the workflow description into the
private Action-specific library `libs/action-merge-conflict-resolution`.

Expose the behavior through the JavaScript Action at
`actions/resolve-merge-conflicts`.

Keep the workflow responsible for GitHub job composition. Keep the Action
entrypoint responsible for GitHub input, output, logging, and failure mapping.
Keep resolver policy and side effects in the private library.

The migration must preserve the behavior documented by
`task.resolve-pull-request-merge-conflicts`.

## Goals

- Reduce the resolver workflow to job composition and checkout bootstrap.
- Add a typed application boundary for merge-conflict resolution.
- Keep merge-conflict Action code under `libs/action-merge-conflict-resolution`,
  outside Seqlane application packages.
- Reuse the existing OSS GitHub communication package through a resolver-scoped
  adapter.
- Keep future OpenCode and service Actions outside this library.
- Keep GitHub platform access separate from Git and filesystem access.
- Keep the generic Seqlane conflict-resolution workflow executor-neutral.
- Preserve current conflict, lockfile, OpenCode, staging, and push behavior.
- Make Git behavior testable with real temporary repositories.
- Bundle the Action and all required Action runtime dependencies.

## Non-goals

- Add automatic pull-request event triggers.
- Accept fork pull requests.
- Add squash resolution.
- Add a public Seqlane package for GitHub automation.
- Add a generic `github-action-support` package.
- Move generic OpenCode or service lifecycle code into the resolver library.
- Add GitHub platform types to `@seqlane/core` or runner IPC.
- Change the generic Seqlane workflow authoring contract.
- Change the OpenCode permission policy.
- Change the current merge or rebase product behavior.

This Action code is CI and platform integration code. It uses private
Seqlane runtime capabilities, but it is not part of the Seqlane application.
It must not extend public workflow authoring, Plan IR, runner IPC, or generic
runtime contracts.

## Terminology

- **Trusted source:** The Seqlane source checked out at the workflow revision.
- **Resolution target:** The separate checkout of the pull-request head.
- **Agent workspace:** A fresh non-Git directory that contains only selected
  regular conflict files.
- **Conflict set:** The paths reported by the unmerged Git index.
- **Agent conflict:** A conflict path that is not `pnpm-lock.yaml`.
- **Lockfile conflict:** A conflict for `pnpm-lock.yaml`.
- **Resolution attempt:** One resolver pass for one rebase stop or merge
  conflict state.
- **Push guard:** The final comparison of captured remote revisions before a
  remote write.

## Requirements

### requirement-action-library-boundary

The implementation must create the private Action-specific library
`libs/action-merge-conflict-resolution`.

The library package name must be `@seqlane/action-merge-conflict-resolution`.

The library directory must not use the `seqlane-` prefix.

The library must not import `@actions/core`, `@actions/github`, GitHub event
globals, or GitHub-specific process environment values.

The Action entrypoint must adapt those values to plain library inputs and
ports.

The package must own merge-resolution orchestration and resolver-specific
Action integration. It must not become a dependency of `libs/seqlane-core`,
`libs/seqlane-runtime`, the CLI, or generic workflow packages.

The package must use the existing OSS GitHub communication package through a
resolver-scoped adapter. It must not introduce a general GitHub client layer.

The package must not own generic OpenCode server lifecycle or unrelated Action
helpers. A future OpenCode or service Action must have its own boundary.

The package can keep the resolver-specific agent behavior required to start
OpenCode only for agent conflicts. It must not expose that behavior as a
generic OpenCode server lifecycle API.

### requirement-application-separation

The implementation must keep the dependency direction from this Action-specific
resolver toward private Seqlane runtime capabilities, not from Seqlane
application packages toward GitHub Actions.

The resolver package can call private Seqlane runtime adapters. The
Seqlane application must not import GitHub API types, Action Toolkit types,
workflow job context, or resolver Action modules.

The package must not expose GitHub or Action types through `@seqlane/core`,
Plans, public workflow APIs, or runner IPC.

### requirement-dependency-and-tooling-boundary

The implementation must apply the following dependency decisions:

| Component | Scope | Required use |
| --- | --- | --- |
| `@actions/core` | Action entrypoint | Read inputs, write outputs and summaries, mask secrets, emit annotations, and set failure status. |
| `@actions/github` | Action GitHub adapter | Create the authenticated Octokit client and read Action context. |
| `@actions/exec` | Optional command adapter | Run foreground Git, Docker, or pnpm commands with argument arrays, explicit `cwd`, and controlled environment values. |
| `@octokit/octokit.js` | Alternative client | Do not add it with `@actions/github`. Use it only for a future direct Octokit adapter. |
| `actionlint` | CI tooling | Check workflow syntax, expressions, Action inputs and outputs, and reusable workflow contracts. |
| `act` | Local smoke testing | Run local Action workflows with Docker and without remote push credentials. |
| `@actions/artifact` | Optional diagnostics | Upload only bounded, redacted failure or test artifacts. |
| `@actions/cache` | CI optimization | Cache only approved dependency data. Do not cache resolver workspaces or Git state. |
| `@actions/tool-cache` | Future tool Action | Download and cache pinned tools only in a dedicated tool Action. |

The resolver library must not import `@actions/core`, `@actions/github`,
`@actions/artifact`, `@actions/cache`, or `@actions/tool-cache`.

If the resolver uses `@actions/exec`, the command adapter must never use a
single interpolated command string. It must pass executable, argument array,
working directory, and environment values separately.

The implementation must verify the SHA-256 value of every downloaded OpenCode
archive before extraction or tool caching.

The local `act` test must not use a real push token or mutate a remote branch.
GitHub-hosted workflow runs remain authoritative for permissions, token
behavior, checkout trust, and remote race handling.

### requirement-workflow-host

The manual workflow must keep these declarations in YAML:

- `workflow_dispatch` input
- `pull_request_number` input
- `resolution_strategy` input with `rebase` as the default
- `contents: write` permission
- `pull-requests: read` permission
- per-pull-request concurrency with `cancel-in-progress: false`
- the Ubuntu runner and the 30-minute timeout
- trusted source and resolution-target checkouts.

The trusted source checkout must use full history and an explicit trusted
revision. The resolution-target checkout must use full history and the
captured pull-request head revision.

The workflow can retain the bootstrap step that obtains the target revision
before the target checkout. The workflow must not retain resolver policy or
Git mutation loops.

### requirement-action-contract

The Action metadata must declare every public input and output.

The Action must accept these inputs:

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `pull-request-number` | positive integer string | none | Pull request to update |
| `resolution-strategy` | `rebase` or `merge` | `rebase` | Integration method |
| `source-directory` | relative path | none | Trusted Seqlane source; required and separate from the target |
| `target-directory` | relative path | none | Pull-request checkout; required and separate from the source |
| `commit` | boolean string | `false` | Permit a merge commit |
| `push` | boolean string | `false` | Permit a remote write |
| `max-attempts` | positive integer string | `10` | Rebase resolution limit |

The production workflow must pass `commit: true` and `push: true` to preserve
the current behavior. The library must not push when `push` is false.

The Action must publish these outputs on success:

| Output | Meaning |
| --- | --- |
| `result` | `no-change` or `updated` |
| `strategy` | The selected strategy |
| `base-sha` | The captured live base revision |
| `head-sha` | The captured pull-request head revision |
| `attempts` | The number of resolution attempts |
| `pushed` | `true` or `false` |

### requirement-pull-request-preflight

The resolver must reject a pull request when any condition below is true:

- the input is not a positive integer
- the pull request is not open
- the head repository is not the current repository
- the base or head revision is not a full hexadecimal Git revision
- the base or head branch name is empty.

The resolver must read the live base branch ref after it reads pull-request
metadata. It must use the live base revision for integration.

The resolver must record the workflow definition ref and SHA in the Action
summary. The summary must not include secret values.

### requirement-git-integration

The Git adapter must use argument arrays and an explicit working directory for
every command.

The adapter must use the Git index as the authoritative conflict source. It
must parse `git ls-files --unmerged -z` or an equivalent NUL-safe plumbing
result.

The adapter must distinguish these outcomes:

- clean integration
- integration paused by conflicts
- operational Git error

The adapter must not parse human-readable Git output to decide whether a
conflict exists.

Before integration, the resolver must reject an unexpected in-progress merge
or rebase. It must not erase unrelated working-tree changes.

For `rebase`, the adapter must run `git rebase <live-base-sha>`.

For `merge`, the adapter must run `git merge --no-commit --no-ff
<live-base-sha>`.

When a merge completes without conflicts, the resolver must abort the pending
no-commit merge and must not create a merge commit.

When a rebase already contains the live base revision, the resolver must not
push a new result.

### requirement-conflict-attempts

Each attempt must perform these actions in order:

1. Read the current unmerged conflict set.
2. Separate agent conflicts from the lockfile conflict.
3. Prepare the agent workspace.
4. Run Seqlane when at least one agent conflict exists.
5. Copy only the allowed agent files back to the resolution target.
6. Regenerate the lockfile when it is in the conflict set.
7. Validate the target workspace.
8. Stage only the original conflict set.
9. Reject remaining unmerged index entries.
10. Run staged whitespace and marker checks.
11. Continue the merge or rebase operation.

The resolver must stop when the attempt count exceeds `max-attempts`.

The default limit must remain `10`.

### requirement-agent-workspace

The agent workspace must be empty, non-Git, and created outside the
resolution-target checkout.

The workspace preparation code must:

- accept only paths from the current conflict set
- reject path traversal
- reject symlinks in every path component
- accept only regular files
- reject binary content for agent files
- limit each agent file to 512 KiB
- limit the total agent payload to 2 MiB
- copy no lockfile into the agent workspace.

The copy-back operation must use the same path allowlist and bounds.

The agent task must receive the exact agent conflict paths and both captured
revisions. It must not receive the lockfile path as an agent-resolvable file.

The agent task must remain non-interactive. It must not use shell commands,
Git commands, tests, builds, package managers, formatters, or network tools.

### requirement-lockfile-regeneration

Lockfile regeneration must use a new temporary workspace for every attempt.

The workspace must contain tracked `pnpm-workspace.yaml` and package manifest
files only. It must not contain the conflicted `pnpm-lock.yaml`.

The input must contain no more than 64 files. Each input file must be no more
than 512 KiB. The total input must be no more than 2 MiB.

The resolver must read an exact pnpm version from the trusted source
`package.json`.

The resolver must keep Node 24, Corepack project-spec bypass, the npm registry,
`--lockfile-only`, `--ignore-scripts`, and `--ignore-pnpmfile` behavior.

The Docker image must remain pinned to:

```text
node@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
```

The regenerated lockfile must be copied back only to
`pnpm-lock.yaml` in the resolution target.

### requirement-seqlane-and-opencode

The resolver must start Seqlane and OpenCode only when at least one agent
conflict exists.

Lockfile-only conflicts must not require `OPENAI_API_KEY`, Seqlane dependency
installation, or OpenCode startup.

The OpenCode archive version must remain `1.18.27` until an explicit contract
change updates the specification. The SHA-256 value must remain
`4af5494f9433f59db8c1e344198f0ee72a50c06ec009fb4a8aeab4c2d4abd702`.

The resolver must check the archive before extraction.

The OpenCode process must listen on loopback only. The policy must deny shell,
external-directory, and project-configuration access. The policy must allow
only the tools required by the current agent workflow.

The resolver must stop OpenCode in a cleanup path before it configures GitHub
authentication for the push.

### requirement-target-validation

The target validator must reject any changed tracked, untracked, or ignored
path that is not in the original conflict set.

The resolver must stage only the original conflict set.

The resolver must reject remaining unmerged index entries.

The resolver must run `git diff --cached --check` after staging.

The resolver must reject default, diff3, CRLF, and longer conflict-marker
lines in staged conflict files.

Marker scanning is supplemental. The unmerged index remains authoritative.

### requirement-rebase-continuation

For a merge strategy, the resolver must stop after the conflict set is staged
and validated. The commit step owns the merge commit.

For a rebase strategy, the resolver must run `GIT_EDITOR=true git rebase
--continue` after each validated attempt.

If the rebase stops without conflicts and both the worktree and index are
clean, the resolver must run `git rebase --skip` for an empty commit.

If the rebase stops without conflicts for another reason, the resolver must
fail.

The resolver must reject a rebase that remains active after a successful skip
without a new conflict set.

When a successful skip advances to another conflicting commit, the resolver
must return the new conflict set and continue the resolution attempts. It must
complete only when the rebase state ends.

### requirement-commit-and-push

Commit and push must remain separate operations.

The resolver must configure the commit identity in the target repository only.
It must not change global Git configuration.

For a merge result, the resolver must create one commit with the current
message pattern:

```text
Merge <base branch> and resolve conflicts
```

Before a remote write, the resolver must fetch the base and head branch refs.
It must reject a changed live base revision.
It must reject a changed remote head revision.

After integration reports its starting head revision, the resolver must
compare it with the captured pull-request head revision. A mismatch must fail
with `REMOTE_HEAD_CHANGED` before agent edits, commit, or push.

For the merge strategy, `push: true` requires `commit: true`. The resolver
must reject that invalid combination before target mutation.

The resolver must push with:

```text
git push --force-with-lease=refs/heads/<head-ref>:<captured-head-sha>
```

The resolver must never fall back to unconditional force push.

### requirement-observability-and-secrets

The resolver must preserve one bounded Seqlane recording per attempt.

The Action must route bounded execution information to the job log and
summary. It must not print raw OpenCode logs or secret values.

The Action must mask `OPENAI_API_KEY` before a child process can write output.

Failures must use typed error categories or stable error codes. Behavior must
not depend on matching error-message text.

## Detailed design or contracts

The application must expose a function with this shape:

```ts
export interface ResolveMergeConflictsRequest {
  readonly pullRequestNumber: number;
  readonly strategy: "rebase" | "merge";
  readonly sourceDirectory: string;
  readonly targetDirectory: string;
  readonly commit: boolean;
  readonly push: boolean;
  readonly maxAttempts: number;
}

export interface ResolveMergeConflictsPorts {
  readonly github: PullRequestMetadataPort;
  readonly git: GitPort;
  readonly files: WorkspaceFilesPort;
  readonly lockfile: LockfilePort;
  readonly agent: AgentRunnerPort;
  readonly summary: SummaryPort;
}

export function resolveMergeConflicts(
  request: ResolveMergeConflictsRequest,
  ports: ResolveMergeConflictsPorts,
): Promise<ResolveMergeConflictsResult>;
```

The exact interfaces can use repository conventions. They must keep these
boundaries:

- GitHub metadata uses a GitHub port.
- Git state uses a Git port.
- Filesystem rules use a workspace-files port.
- Lockfile generation uses a lockfile port.
- Seqlane and OpenCode use an agent port.
- Action summary writes use a summary port.

The controller must own ordering and policy. Adapters must own platform calls.

The library must use package exports for cross-package imports. The Action
build must include the library, its runtime dependencies, and any private
Seqlane adapter required for one-shot execution.

## Failure and edge cases

The resolver must return a typed failure for each case below:

- invalid Action input
- wrong dispatch branch
- closed pull request
- fork pull request
- malformed GitHub response
- changed base or head revision
- missing Git history
- pre-existing merge or rebase state
- conflict without an unmerged index
- unsupported binary agent file
- symlink or path traversal attempt
- workspace size limit breach
- unexpected edited or untracked path
- unresolved conflict after agent work
- remaining conflict marker after staging
- lockfile regeneration error
- OpenCode archive hash mismatch
- OpenCode readiness timeout
- Seqlane task failure
- rebase attempt limit breach
- empty commit that cannot be skipped
- remote head race
- remote base race
- refused push

The resolver must preserve the current target checkout when it stops with a
failure. It must not use `git reset --hard` or `git clean -fd` as recovery.

## Migration

Implement the migration in these stages:

1. Add the Action library package and pure contracts.
2. Move the typed workspace and staged-content rules into the library.
3. Add the resolver-scoped `@actions/github` adapter, plus
   Git, filesystem, lockfile, OpenCode, and Seqlane adapters.
4. Implement the resolution controller and commit/push guards.
5. Wire the Action entrypoint and declare its metadata.
6. Build and verify the committed Action bundle.
7. Replace the workflow shell loop with the local Action.
8. Keep only the required workflow bootstrap and job composition.
9. Move tests from workflow-text assertions to library and Action tests.
10. Remove the old helper script after all workflow references are removed.
11. Update operator documentation and SDLC traceability.

The generic workflow in `examples/resolve-merge-conflicts.ts` remains the
source of the agent task contract. If the Action bundle needs a compiled
workflow module, expose it through a declared private package export. Do not
import the example through a relative path from another package.

## Verification

Run the following checks in dependency order:

```text
pnpm run test:mapping
pnpm exec nx run action-merge-conflict-resolution:typecheck
pnpm exec nx run action-merge-conflict-resolution:test
pnpm exec nx run action-resolve-merge-conflicts:typecheck
pnpm exec nx run action-resolve-merge-conflicts:build
git diff --exit-code -- actions/*/dist/
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

The focused test set must include real temporary Git repositories for clean
merge, content conflict, modify/delete conflict, binary conflict, empty
commit, repeated rebase stop, unrelated changes, shallow history, and remote
head race scenarios.

The production workflow must run the trusted local Action with
`uses: ./seqlane-source/actions/resolve-merge-conflicts`. Any local Action
verification must keep remote push behavior disabled.

## Acceptance criteria

- `libs/action-merge-conflict-resolution` exists and owns resolver-specific
  Action behavior.
- The dependency choices in `requirement-dependency-and-tooling-boundary` are
  visible in package manifests and CI checks.
- The package directory does not use the `seqlane-` prefix.
- The package uses the existing OSS GitHub communication client through a
  narrow resolver adapter.
- Seqlane application packages do not depend on this Action-specific package.
- Generic OpenCode and service Action lifecycle code is outside this package.
- The Action entrypoint contains no Git conflict algorithm or shell script.
- The Action metadata declares every input and output.
- The production workflow invokes the local Action.
- The workflow retains required triggers, permissions, concurrency, checkouts,
  and bootstrap behavior.
- The resolver preserves all requirements from
  `task.resolve-pull-request-merge-conflicts`.
- Git conflicts are detected from the unmerged index.
- Agent files and lockfile files use separate resolution paths.
- All workspace, staged-content, marker, and size guards remain active.
- OpenCode runs only for agent conflicts and stops before push authentication.
- Merge commits and force-with-lease pushes remain explicit.
- Remote base and head races fail without an unsafe push.
- The Action bundle is current and self-contained.
- Tests cover the required Git scenarios with real temporary repositories.
- The old workflow helper has no remaining production references.
- Operator documentation explains the Action inputs, secret, permissions,
  checkout trust model, and push behavior.

## Traceability

- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- Prior behavior: [task.resolve-pull-request-merge-conflicts](../tasks/2026-09-04-resolve-pull-request-merge-conflicts.md)
- Executor boundary: [spec.executor-neutral-workflow-authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
- Autonomous execution: [spec.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md)
- Local commands: [spec.local-mechanical-tasks](./2026-09-03-local-mechanical-tasks.md)
- Runner process: [spec.dedicated-runner-process](./2026-09-02-dedicated-runner-process.md)
- Executor boundary decision: [adr.executor-neutral-workflow-authoring](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- Autonomous execution decision: [adr.autonomous-non-interactive-execution](../adrs/2026-09-02-autonomous-non-interactive-execution.md)
- Local command decision: [adr.local-mechanical-tasks](../adrs/2026-09-03-local-mechanical-tasks.md)
- Runner process decision: [adr.dedicated-runner-process](../adrs/2026-09-02-dedicated-runner-process.md)
