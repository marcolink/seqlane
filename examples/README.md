# Seqlane workflow examples

These workflows are local source examples. They are not a package or a CLI
catalog.

## Development

Run a file directly from the repository root:

```sh
seqlane run examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime opencode
```

Direct file references load the module's default export. Use
`path/to/workflow.ts#namedExport` only when a module intentionally exports a
named workflow. The CLI supports `.ts`, `.mts`, `.js`, and `.mjs` files.

The minimal workflow explicitly selects `openai/gpt-5.6-luna` with `high`
reasoning for its `prepare` session and `openai/gpt-5.6-terra` for its `finish`
session.

`local-git-status.ts` runs a direct `git status --porcelain=v1` task, then
passes its typed result to an agent task:

```sh
seqlane run examples/local-git-status.ts \
  --input '{}' \
  --runtime opencode \
  --workspace "$PWD"
```

`local-only.ts` contains no agent work and runs without a runtime profile:

```sh
seqlane run examples/local-only.ts \
  --input '{"value":"local"}'
```

The repository's `workflow-read-context` workflow is defined in `read-context.ts`. It
uses `openai/gpt-5.6-luna` with medium reasoning:

```sh
seqlane run read-context.ts \
  --input '{"question":"Trace how model settings reach the session request","paths":["libs/runtime/src"]}' \
  --runtime opencode \
  --workspace "$PWD"
```

The workflow keeps retrieval deterministic and bounded. zvec-grep and Ripwire
are optional. Configure the selected Seqlane runtime before running it.

Workflow files run as local Node.js code in the runner process. Run only files
you trust. TypeScript files use Node.js 24 native type stripping; use
erasable TypeScript syntax or compile unsupported syntax to `.mjs`.

Examples may import `@seqlane/core` and `zod`. When copying an
example to another project, install those dependencies there.

To inspect OpenCode server logs during a local run, start the server in one
terminal with `--print-logs`, then configure the Seqlane adapter and run the
workflow command in another. The repository OpenCode configuration selects
`openai/gpt-5.6-luna`.

```sh
opencode serve --hostname 127.0.0.1 --port 4096 --print-logs
export SEQLANE_RUNTIME_ADAPTER_CONFIG='{"adapter":"opencode","url":"http://127.0.0.1:4096"}'
```

`pr-code-review.ts` is an autonomous pull-request code-review workflow. It
uses the supplied base branch for context and compares the matching explicit
base and head revisions, using the pull-request title and description as
untrusted author-supplied context. It verifies previous findings first. It
then runs correctness, maintainability, and risk lanes in parallel before it
produces a five-axis rating. Review tasks only read supplied evidence and
targeted workspace files;
they do not execute scripts, tests, builds, package managers, Git, or shell
commands. File inspection uses workspace-relative paths and stays inside the
review workspace.
Each review lane uses an independent `openai/gpt-5.6-luna` session with high
reasoning; the final summary uses an isolated `openai/gpt-5.6-luna` session
with high reasoning. The pull-request description remains the author-owned
statement of intent; no intermediate task rewrites it into generated
requirements or evidence.
The current OpenCode tasks use `workspace: "shared"` because the author asserts
they may overlap. This is not a read-only workspace boundary; configure the
runtime accordingly.

```sh
seqlane run examples/pr-code-review.ts \
  --input '{"repository":"/path/to/repository","baseBranch":"release/2026.09","baseRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pullRequest":{"number":123,"title":"Add automated review","description":"Run Seqlane for every pull request."}}' \
  --runtime opencode \
  --workspace /path/to/repository
```

## Automated pull-request review

`.github/workflows/seqlane-code-review.yml` runs the code-review example for
non-draft pull requests from branches in this repository. Configure the
`OPENAI_API_KEY` Actions secret to enable it. Without the secret, the workflow
reports a successful skip.

Every review job logs and adds the workflow definition ref and immutable SHA to
the GitHub Actions job summary. This identifies the exact workflow revision
that GitHub executed, independently of the reviewed pull-request revision.

The workflow uses `pull_request_target`, runs the trusted workflow definition
from the base branch (the repository's normal base is `main`), and checks out
the resolved trusted base revision as the Seqlane source for automatic runs.
It checks out the pull-request head separately as the review target. Manual
branch runs use the selected branch's workflow and source revision for trusted
branch testing.
The workflow first admits an event, before it enters per-pull-request
concurrency. Only an eligible pull-request update, a trusted comment with a
recognized `/seqlane` command, or a manual dispatch with a pull-request number
can enter that group. Other comments, including the bot's report comment, do
not cancel, queue, or block an active review. Eligible reviews for the same
pull request cancel older in-progress work so only the latest review can
publish. When a pull request closes, a no-op cancellation job joins the same
group and interrupts active review work without starting a replacement review.
The publisher also checks the live pull-request state before it writes.
Progress-marker cleanup is run-specific, so an older canceled run cannot remove
a newer run's notice.
Only open pull requests are eligible for review; manual and comment-triggered
runs for closed pull requests also skip the review.

The workflow reads the pull request's configured base branch and immutable base
revision from the event, then reviews the explicit base-to-head range in a
separate checkout. A local workflow task validates the requested Git range and
collects bounded changed-file, diff-stat, unified-patch, and whitespace-check
evidence with explicit overflow metadata. Specialist lanes review the supplied
patch and pull-request description first, then use targeted workspace reads
only when the patch is truncated or surrounding context is needed. They run in
independent sessions before the final synthesis, which preserves the exact
repository and base/head identity fields from its supplied review context. The
workflow invokes the committed Node 24 `actions/code-review` bundle from the
trusted Seqlane checkout. The Action calls `startWorkflowRun` with its
statically bundled workflow; it does not install dependencies, build the CLI,
or execute repository scripts from the separate review target. OpenCode ignores
project runtime configuration during the review and receives a read-only tool
policy. Repository skills are staged only when their directories are unchanged
from the pull-request base revision; new or modified target skills are reported
and excluded. Skill calls are retained in native telemetry and bounded run
metrics by individual skill name. The workflow reads a bounded set of recent
issue and review comments.
It updates one marked comment
from the trusted GitHub Actions bot. It records the report verdict without
failing the review job when it is `request-changes`. It accepts review reruns
and disposition commands only from reviewers with GitHub `OWNER`, `MEMBER`, or
`COLLABORATOR` association. Editing a disposition comment also reruns the
review so removing a command removes its policy decision.

The review runtime denies access outside the review workspace and blocks
environment files. Git streams a patch that excludes common lockfiles and
generated `dist` contents (`**/dist/**`) to the bounded model-facing evidence
collector. Excluded paths remain in changed-file metadata. Lockfile contents and
generated `dist` contents are not reviewed. For excluded generated output, the
reviewer validates the corresponding source and build metadata and requires
recorded artifact or bundle drift verification when relevant. The retained
patch uses ten lines of hunk context, is limited to 512,000 bytes, and does not
materialize the complete diff.
Published review comments do not list slash-command syntax. This prevents the
report from inviting commands while the command lifecycle is being revised.
The CI workflow manages the loopback OpenCode, zvec-grep, and Ripwire servers
through local GitHub Actions. Both zvec-grep and Ripwire index the checked-out
review target. Ripwire authenticates with the per-run token generated by its
Action. OpenCode can use only Ripwire's read-only tools, while zvec-grep
remains available through its existing read-only search tool.

The publisher assigns each finding a permanent `SEQ-PR<PR>-<index>` ID. It
does not reuse an ID for a different finding. It retains old `F-*` IDs as
aliases when it migrates a version 1 or version 2 report.

`fixed` changes a finding to `Addressed`. The finding stays active until the
independent history task verifies the fix against the current head. A verified
fix changes the status to `Resolved`. `wont-fix` changes the status to
`Dismissed`. `downgrade` keeps the finding active with a lower effective
severity. If a resolved or dismissed problem appears again, its status changes
to `Reopened`.

The visible comment is a human-readable projection. A collapsed JSON code
block stores the canonical version 3 state as bounded gzip and Base64 data.
The state includes full commit IDs, lifecycle data, and dispositions. A single
marked JSON object in the same authoritative comment stores the run metrics
ledger. Each ledger entry contains the GitHub workflow run ID and attempt,
completion time, reviewed revision, and a mechanically generated metrics object
with task result state, duration, model, tokens, and cost totals. The visible
run count, absolute pull-request cost, and latest-run cost are derived from the
ledger's `runs` array at render time. No agent calculates these values, and no
separate per-run audit comments are created or read. A missing, malformed,
unsupported, or legacy ledger starts a fresh metrics ledger without discarding
valid review state; no metrics migration is performed. The publisher re-reads
the trusted report immediately before writing and skips stale concurrent writes.
When a new review starts and a trusted report already exists, the workflow
temporarily prepends a prominent in-progress notice. It removes that notice
after publication or cleanup.
Previous state is accepted only from a marked comment by the GitHub Actions bot
and only after strict schema validation. Legacy snapshots remain readable for
migration. State or comment truncation appears in the review limitations. The
publisher checks the live pull-request head immediately before it writes the
comment. It refuses to publish a stale result. Configured secret values are
redacted from CI output, workflow summaries, and GitHub annotations.

To exercise the workflow and Seqlane source from a feature branch, run the
workflow manually with that branch selected:

```sh
gh workflow run "Seqlane code review" \
  --ref my-review-branch \
  -f pull_request_number=123
```

Automatic pull-request and comment-triggered runs continue to use the trusted
main/base workflow path. The manual path is intended for trusted branch
testing and uses the selected branch's workflow and Seqlane source revision.
The review runtime denies access outside the review workspace and blocks
environment files. Git streams only a bounded patch prefix to the review task,
which retains complete UTF-8 lines and does not materialize the full diff.
For the zvec-grep evaluation, the workflow builds a local semantic index of the
review target, starts a loopback-only MCP server, and permits only its
read-only search tool. Ripwire also indexes the same review target and exposes
its read-only analysis tools through an authenticated loopback MCP server. The
Ripwire token is generated for each run and is redacted from review recordings
and exported events. Indexing uses a review-source allowlist and explicitly
excludes dependency, generated, cache, environment, credential, and key paths;
in particular, `node_modules` is never indexed. Default zvec-grep and
repository ignore rules remain enabled. Review tasks use workspace-relative
paths for native read, glob, and grep. They pass the exact review workspace root
to zvec-grep, while Ripwire calls omit `path` and `paths` so the pinned
review-workspace root supplies scope. Tasks do not force indexed searches when
native evidence is sufficient, and they never search parent, runner, or trusted
source paths.

## Manual merge-conflict resolution

`.github/workflows/seqlane-resolve-merge-conflicts.yml` resolves conflicts for
an open pull request after a maintainer dispatches the workflow. Enter the
pull-request number, select `rebase` or `merge`, and run the workflow from the
default branch. The required strategy defaults to `rebase`. Configure the
`OPENAI_API_KEY` and `SEQLANE_RESOLVER_TOKEN` Actions secrets before you run
it. `SEQLANE_RESOLVER_TOKEN` must be a dedicated fine-grained token with
`Contents: write` and `Workflows: write` access to this repository. The
workflow's `GITHUB_TOKEN` only needs `contents: read` and
`pull-requests: read`. The workflow uses it for metadata and checkout reads.

The workflow accepts only a head branch in this repository. It captures the
live base branch revision and the pull-request head revision, then applies the
selected strategy in a separate checkout. A rebased branch uses
`--force-with-lease` against its captured head revision. If Git reports no
merge conflicts, the merge strategy stops without a commit.

If conflicts exist, the local `resolve-merge-conflicts` Action receives the
exact conflict paths and both immutable revisions. Its exclusive agent task
runs in a fresh, non-Git staging workspace that contains only regular conflict
files. The OpenCode policy denies shell commands, external paths, and project
configuration. The Action rejects symlinks and copies back only the supplied
conflict files.

Lockfile conflicts use a separate Docker-based regeneration workspace. The
workspace contains only tracked manifests and `pnpm-workspace.yaml`; it does
not contain the conflicted lockfile or a model workspace.

The job summary reports the overall outcome and bounded diagnostics. For a
rebase it adds one escaped, human-readable section per conflicting commit with
the old short SHA, subject, model summary, and file decisions. A merge uses one
`Merge resolution` section. Raw executor events and full file contents are not
printed.

After Seqlane finishes, the Action rejects new files and edits outside the
initial conflict list. It also rejects unresolved conflicts and Git whitespace
errors. It rejects staged Git conflict markers. A rebase can use no more than
ten conflict-resolution attempts and skips redundant empty commits. It detects
default, diff3, and longer conflict markers. The workflow stops OpenCode before it
configures GitHub credentials. The OpenCode process does not receive the push
token. Then the workflow creates one merge commit or pushes the rebased history.

The Action checks the same live base revision that it captured before
resolution immediately before it pushes. The exact force-with-lease protects
the remote head revision. A base update after that check can make the result
stale, but it cannot overwrite the base branch.

The Action downloads the pinned OpenCode release archive over HTTPS. It
checks the archive SHA-256 before extraction. It does not run a remote installer
script.

The Action configures `Seqlane conflict resolver` as the Git committer. A
merge commit uses that name as its author. A rebase preserves each original
commit author and records that name as its committer.

`all-features.ts` is the compact feature tour. It uses typed input/output,
shared and exclusive workspaces, isolated/reused/branched sessions, explicit
dependencies, whole/nested/literal bindings, references, Studio observability
selections, fan-out/fan-in, mechanical gates, and one validated polish step.
The two branch lanes can run concurrently, so the example stays small and
fast. It currently omits repeat nodes because the Mastra Plan compiler does
not support them.

```sh
seqlane run examples/all-features.ts \
  --input '{"topic":"Seqlane","focus":"typed workflows"}' \
  --runtime opencode
```
