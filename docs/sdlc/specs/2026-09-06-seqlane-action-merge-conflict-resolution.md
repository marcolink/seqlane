---
id: spec.seqlane-action-merge-conflict-resolution
title: Seqlane Action Merge Conflict Resolution
status: active
owners:
  - core
created: 2026-09-06
updated: 2026-09-11
upstream:
  - adr.seqlane-action-library-boundary
  - adr.runner-built-action-bundles
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
Keep resolver execution, validation, and side effects in the private library.
Accept a versioned, repository-specific conflict-handler policy as the
formatted multiline JSON value of the trusted workflow's `conflict-handlers`
Action input. The policy supplies static mechanical handler recipes, is not
model instructions, and is never loaded from the resolution target.

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
- Allow repositories to declare mechanical handlers for generated-file
  conflicts without moving handler execution into workflow shell logic.
- Keep handler execution isolated from secrets, credentials, and the normal
  workflow process even when a handler executes target checkout code or
  configuration.

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
- Load a conflict-handler policy from the resolution-target checkout.
- Send generated-file conflicts to the model or use a model-selected handler.

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
- **Conflict-handler policy:** A versioned static JSON policy supplied by the
  trusted workflow through the `conflict-handlers` input. It maps
  repository-relative conflict globs to mechanical handler definitions and
  output globs.
- **Generated-file rule:** One policy entry with a repository-relative `match`
  glob, one or more repository-relative `outputs` globs, and a nested `handler`
  recipe.
- **Generated-file handler:** A deterministic operation selected by a policy
  rule. Handler setup, command execution, output validation, and staging are
  mechanical operations; none is delegated to the model.
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
- `contents: read` permission for metadata and checkout operations
- `pull-requests: read` permission
- per-pull-request concurrency with `cancel-in-progress: false`
- the Ubuntu runner and the 30-minute timeout
- trusted source and resolution-target checkouts.

The trusted source checkout must use full history and an explicit trusted
revision. The resolution-target checkout must use full history and the
captured pull-request head revision.

The workflow can retain the bootstrap step that obtains the target revision
before the target checkout. The Action must receive the formatted multiline
JSON `conflict-handlers` input from the trusted workflow revision. It must not
accept policy contents from the target checkout or retain resolver
implementation or Git mutation loops.

The workflow must bootstrap the pinned Node and pnpm toolchain, install
trusted-source dependencies with a frozen lockfile and scripts disabled, and
build the resolver Action before it runs. It must not install or execute target
dependencies in the ordinary workflow process. A handler that needs target dependencies must run
its declared setup and command inside the isolated handler environment defined
by `requirement-generated-file-handlers`.

The production workflow must pass `secrets.SEQLANE_RESOLVER_TOKEN` to the
Action's `push-token` input. This dedicated secret must have only the
repository `Contents: write` and `Workflows: write` permissions required for
the force-with-lease branch update and workflow-file changes. The workflow's
`GITHUB_TOKEN` must remain read-only and must be used only for metadata reads.

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
| `push-token` | secret string | empty | Dedicated token used for remote writes when `push` is `true` |
| `max-attempts` | positive integer string | `10` | Rebase resolution limit |
| `conflict-handlers` | formatted multiline JSON string | `{ "version": 1, "rules": [] }` | Trusted static conflict-handler policy |

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
2. Classify generated-file, agent, and lockfile conflicts using the validated
   static policy and built-in lockfile rule.
3. Execute each matching generated-file handler mechanically.
4. Prepare the agent workspace for remaining agent conflicts.
5. Run Seqlane when at least one agent conflict exists.
6. Copy only the allowed agent files back to the resolution target.
7. Regenerate the lockfile when it is in the conflict set.
8. Validate the target workspace and every generated-file handler output.
9. Stage only the original conflict set.
10. Reject remaining unmerged index entries.
11. Run staged whitespace and marker checks.
12. Continue the merge or rebase operation.

The resolver must stop when the attempt count exceeds `max-attempts`.

The default limit must remain `10`.

### requirement-generated-file-handlers

The Action must accept the formatted multiline JSON `conflict-handlers` input
from the trusted workflow. It must parse and validate a versioned JSON document
containing a list of rules. An empty rule list is valid and preserves the
existing agent and built-in lockfile paths. The Action must never read this
configuration from the resolution target.

Each rule must contain:

- `match`: a non-empty repository-relative glob used to match conflicted
  paths;
- `outputs`: a non-empty list of repository-relative globs that is the complete
  allowlist of paths the handler may create or modify; and
- `handler`: a nested validated static handler recipe, including executable and
  argument data rather than an interpolated shell command string.

The JSON shape is conceptually:

```json
{
  "version": 1,
  "rules": [
    {
      "match": "actions/*/dist/main.js",
      "outputs": ["actions/*/dist/main.js"],
      "handler": {
        "command": ["pnpm", "build"]
      }
    }
  ]
}
```

The built-in `pnpm-lock.yaml` regeneration handler remains enabled without a
policy rule. A policy rule that matches `pnpm-lock.yaml` must be rejected; the
conflict-handlers policy cannot override, replace, or disable the built-in
lockfile handler.

The policy validator must reject absolute paths, `..` traversal, invalid glob
syntax, empty output lists, duplicate or ambiguously overlapping rules, and
handler recipes that do not meet the resolver's allowed command and resource
limits. The resolver must normalize all paths to repository-relative form
before matching. A policy rule must not be able to select the Action bundle,
the resolver source, Git metadata, credentials, or files outside the target
checkout. The policy must not override the built-in `pnpm-lock.yaml`
regeneration path.

For every conflicted path matched by a generated-file rule, the resolver must
select the rule's handler deterministically and exclude that path from model
resolution. The handler may operate on the complete set of paths selected by
its rule. After setup and command execution, the resolver must compute the
workspace change set and require every changed path to match that rule's
`outputs` globs. It must stage only validated output paths that are part of
the original conflict set and must reject unexpected changes or unresolved
index entries.

Handler setup, command execution, output validation, and staging are one
mechanical operation. If any phase fails, the complete resolution attempt must
fail. There is no stage-3, model, or other fallback for a generated-file
handler failure.

The handler command may execute code or configuration from the resolution
target, including package-manager scripts or build configuration. Therefore
the resolver must execute it in an isolated, unprivileged environment outside
the normal workflow process. The environment must receive no GitHub token,
push token, OpenAI key, credential helper, SSH key, or other Action secret. It
must use a dedicated temporary workspace, bounded resource and output
allowlists, and a disabled or explicitly allowlisted network. The handler
must not be able to provide or replace the trusted Action bundle or resolver
source.

The workflow-level toolchain bootstrap is limited to the trusted source
checkout: it may install the pinned Node/pnpm toolchain and trusted-source
dependencies with a frozen lockfile and lifecycle scripts disabled. Any
target dependency installation required by a handler is part of that handler's
isolated recipe and is subject to the same no-secret, no-credential, network,
and output restrictions.

### requirement-agent-workspace

The agent workspace must be empty, non-Git, and created outside the
resolution-target checkout.

The workspace preparation code must:

- accept only paths from the current conflict set
- reject path traversal
- reject symlinks in every path component
- accept only regular files
- reject binary content for agent files
- limit each agent file to 1 MiB
- limit the total agent payload to 2 MiB
- copy no lockfile into the agent workspace.

The copy-back operation must use the same path allowlist and bounds.

The agent task must receive the exact agent conflict paths and both captured
revisions. It must not receive the lockfile path as an agent-resolvable file.

At the agent runner/output boundary, `resolvedFiles` and decision paths must
each exactly and uniquely cover the requested agent conflict paths. Missing,
extra, and duplicate paths must be rejected before the controller records an
attempt report.

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
authentication for the push. The Action adapter must expose `start`,
`resolve`, and idempotent `stop` on one lazily created runner instance. It must
create that runner only after pull-request metadata is available and must
delegate cleanup on failures as well as before push authentication.

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

When `push` is `true`, the Action must reject an empty `push-token` before
integration or agent startup. The token must be masked before application
work starts, passed only to the push adapter, and excluded from the OpenCode
child environment.

### requirement-observability-and-secrets

The resolver must create one independently bounded Seqlane recording per agent
attempt. Mechanical-only attempts must report zero events and `truncated: false`.

The Action must route a concise overall outcome and human-readable resolution
report to the job summary. Rebase reports must contain one section per
conflicting commit with the old commit short SHA, subject, validated model
summary, and per-file decisions. Merge reports must contain one
`Merge resolution` section. All untrusted Markdown values must be escaped.

The job log and summary may include only bounded per-attempt diagnostics
digests with the event count and truncation status. They must not print raw
OpenCode event payloads, full file contents, or secret values. Model summaries,
commit subjects, paths, and decisions must pass through the canonical
configured-secret redaction boundary before Markdown escaping or publication.
Attempt reports must be aggregated by the resolver controller and must not
expose executor internals.

The job summary must enforce an independent total character budget. It must
cap retained/rendered attempts and decisions and append a bounded,
human-readable truncation digest when caps or the total budget omit content.
The final rendered summary must never exceed the declared total limit.

The active Action job log must publish bounded progress events. For a rebase,
it must distinguish the commits planned for replay, conflict stops reached,
and total resolution passes; a resolution pass can repeat a conflict stop.
For a merge, it must not claim a rebase commit count. A rebase event may name
the current rebase commit only through the same secret-redaction and
single-line bounding boundary as the final summary. Live progress must not
include file paths, model summaries, raw executor events, command arguments,
or unbounded diagnostics.

The runtime workflow output schema is the canonical validator for agent
summaries and decisions. The runner must return validated output and reject
malformed output before the controller records an attempt report.

The Action must mask `OPENAI_API_KEY` before a child process can write output.

Failures must use typed error categories or stable error codes. Behavior must
not depend on matching error-message text. A refused Git push must retain a
bounded, control-character-free, credential-free diagnostic derived from Git
stderr. The Action must log that diagnostic through the Actions Toolkit after
it masks all configured secrets. It must not log raw command arguments,
credentials, credential URLs, or unbounded output.

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
  readonly conflictHandlers: ConflictHandlerPolicy;
}

export interface ConflictHandlerPolicy {
  readonly version: 1;
  readonly rules: readonly ConflictHandlerRule[];
}

export interface ConflictHandlerRule {
  readonly match: string;
  readonly outputs: readonly string[];
  readonly handler: ConflictHandler;
}

export interface ConflictHandler {
  readonly command: readonly string[];
  readonly setup?: readonly (readonly string[])[];
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
- invalid or ambiguous `conflict-handlers` JSON policy
- generated-file handler setup or command failure
- generated-file handler output outside its declared globs
- generated-file handler sandbox or staging failure
- OpenCode archive hash mismatch
- OpenCode readiness timeout
- Seqlane task failure
- rebase attempt limit breach
- empty commit that cannot be skipped
- remote head race
- remote base race
- refused push
- missing dedicated push token

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
6. Configure and verify the cacheable runner-built Action bundle.
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
- The Action accepts only the trusted workflow's formatted multiline JSON
  `conflict-handlers` input and validates its versioned rules, each with
  repository-relative `match` and non-empty `outputs` globs plus a nested
  static `handler` recipe.
- The built-in `pnpm-lock.yaml` regeneration path works without a policy rule
  and cannot be overridden by repository configuration.
- Generated-file handlers run mechanically, outside model resolution, and
  fail the complete attempt on setup, command, output-validation, sandbox, or
  staging failure without a fallback.
- Handler output validation rejects every changed path not covered by the
  matching rule's `outputs` globs.
- Handler execution receives no Action secrets or credentials and cannot
  replace the trusted Action bundle or resolver source.
- Git conflicts are detected from the unmerged index.
- Agent files and lockfile files use separate resolution paths.
- Agent workspace inputs cap each file at 1 MiB and the total at 2 MiB.
- Lockfile workspace inputs cap each file at 512 KiB and the total at 2 MiB.
- All workspace, staged-content, marker, and size guards remain active.
- OpenCode runs only for agent conflicts and stops before push authentication.
- The Action exposes one lazy agent lifecycle with idempotent cleanup on
  success and failure.
- Pushes require a dedicated masked token and use a read-only workflow token
  for metadata.
- Refused pushes expose only bounded, sanitized operator diagnostics.
- Merge commits and force-with-lease pushes remain explicit.
- Remote base and head races fail without an unsafe push.
- The Action bundle is self-contained and built from the trusted workflow
  revision before local invocation.
- Tests cover the required Git scenarios with real temporary repositories.
- The old workflow helper has no remaining production references.
- Operator documentation explains the Action inputs, dedicated secret,
  permissions,
  checkout trust model, and push behavior.

## Traceability

- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- Packaging: [adr.runner-built-action-bundles](../adrs/2026-09-11-runner-built-action-bundles.md)
- Prior behavior: [task.resolve-pull-request-merge-conflicts](../tasks/2026-09-04-resolve-pull-request-merge-conflicts.md)
- Executor boundary: [spec.executor-neutral-workflow-authoring](./2026-09-02-executor-neutral-workflow-authoring.md)
- Autonomous execution: [spec.autonomous-non-interactive-execution](./2026-09-02-autonomous-non-interactive-execution.md)
- Local commands: [spec.local-mechanical-tasks](./2026-09-03-local-mechanical-tasks.md)
- Runner process: [spec.dedicated-runner-process](./2026-09-02-dedicated-runner-process.md)
- Generated-file handlers: [task.configure-generated-file-conflict-handlers](../tasks/2026-09-08-configure-generated-file-conflict-handlers.md)
- Executor boundary decision: [adr.executor-neutral-workflow-authoring](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- Autonomous execution decision: [adr.autonomous-non-interactive-execution](../adrs/2026-09-02-autonomous-non-interactive-execution.md)
- Local command decision: [adr.local-mechanical-tasks](../adrs/2026-09-03-local-mechanical-tasks.md)
- Runner process decision: [adr.dedicated-runner-process](../adrs/2026-09-02-dedicated-runner-process.md)
