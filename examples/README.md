# Seqlane workflow examples

These workflows are local source examples. They are not a package or a CLI
catalog.

## Development

Run a file directly from the repository root:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096
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
pnpm exec node apps/seqlane-cli/bin/run.js run examples/local-git-status.ts \
  --input '{}' \
  --runtime http://127.0.0.1:4096 \
  --workspace "$PWD"
```

`local-only.ts` contains no agent work and runs without a runtime profile:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/local-only.ts \
  --input '{"value":"local"}'
```

Workflow files run as local Node.js code in the runner process. Run only files
you trust. TypeScript files use Node.js 24 native type stripping; use
erasable TypeScript syntax or compile unsupported syntax to `.mjs`.

Examples may import `@seqlane/core` and `zod`. When copying an
example to another project, install those dependencies there.

To inspect OpenCode server logs during a local run, start the server in one
terminal with `--print-logs`, then run the workflow command in another. The
repository OpenCode configuration selects `openai/gpt-5.6-luna`.

```sh
opencode serve --hostname 127.0.0.1 --port 4096 --print-logs
```

`pr-code-review.ts` is an autonomous pull-request code-review workflow. It
uses the supplied base branch for context and compares the matching explicit
base and head revisions, using the pull-request title and description as
untrusted author-supplied context. It runs correctness,
maintainability, and risk lanes in parallel before producing a five-axis
rating. Review tasks only read supplied evidence and targeted workspace files;
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
pnpm exec node apps/seqlane-cli/bin/run.js run examples/pr-code-review.ts \
  --input '{"repository":"/path/to/repository","baseBranch":"release/2026.09","baseRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pullRequest":{"title":"Add automated review","description":"Run Seqlane for every pull request."}}' \
  --runtime http://127.0.0.1:4096 \
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
from the base branch, and checks out the resolved trusted base revision as the
Seqlane source for automatic runs. It checks out the pull-request head
separately as the review target. Manual branch runs use the selected branch's
workflow and source revision for trusted branch testing.
When a pull request closes, the workflow triggers a cancellation event that
uses the same concurrency group to cancel any active review, while its review
job is skipped.

The workflow reads the pull request's configured base branch and immutable base
revision from the event, then reviews the explicit base-to-head range in a
separate checkout. A local workflow task validates the requested Git range and
collects bounded changed-file, diff-stat, unified-patch, and whitespace-check
evidence with explicit overflow metadata. Specialist lanes review the supplied
patch and pull-request description first, then use targeted workspace reads
only when the patch is truncated or surrounding context is needed. They run in
independent sessions before the final synthesis, which preserves the exact
repository and base/head identity fields from its supplied review context. The
workflow installs and builds the checked-out Seqlane
source, but does not install dependencies or execute repository scripts from
the separate review target. OpenCode ignores project runtime configuration
during the review and receives a read-only tool policy. The workflow reads a
bounded set of recent issue and review comments, updates one marked
pull-request comment with the report, and records the report verdict without
failing the review job when it is `request-changes`. It accepts review reruns
and disposition commands only from reviewers with GitHub `OWNER`, `MEMBER`, or
`COLLABORATOR` association. Editing a disposition comment also reruns the
review so removing a command removes its policy decision.

```text
/seqlane review
/seqlane wont-fix F-123 reason: accepted risk
/seqlane fixed F-123
/seqlane downgrade F-123 optional reason: low impact
```

`fixed` is verified against the current pull-request head. `wont-fix` and
`downgrade` are recorded with the actor, effective timestamp, reason, and
commit context; they do not remove the finding from the report, but an
authorized disposition does remove it as a merge-blocking finding. Previous
reports are accepted only from the Seqlane bot identity and use a compact,
schema-validated snapshot. Snapshot or comment truncation is recorded as a
review limitation. Configured secret values are redacted from CI output,
workflow summaries, and GitHub annotations.

To exercise the workflow and Seqlane source from a feature branch, run the
workflow manually with that branch selected:

```sh
gh workflow run "Seqlane code review" \
  --ref my-review-branch \
  -f pull_request_number=123
```

Automatic pull-request and comment-triggered runs continue to use the trusted
base revision for the workflow source. The manual path is intended for
trusted branch testing and uses the selected branch's workflow and Seqlane
source revision.
The review runtime denies access outside the review workspace and blocks
environment files. Git writes the complete patch to a run-scoped temporary file
before the retained model-facing patch is bounded; the temporary file can be
larger than the 48,000-byte evidence limit and is removed after collection.
For the zvec-grep evaluation, the workflow builds a local semantic index of the
review target, starts a loopback-only MCP server, and permits only its
read-only search tool. Indexing uses a review-source allowlist and explicitly
excludes dependency, generated, cache, environment, credential, and key paths;
in particular, `node_modules` is never indexed. Default zvec-grep and
repository ignore rules remain enabled.

## Manual merge-conflict resolution

`.github/workflows/seqlane-resolve-merge-conflicts.yml` resolves conflicts for
an open pull request after a maintainer dispatches the workflow. Enter the
pull-request number, select `rebase` or `merge`, and run the workflow from the
default branch. The required strategy defaults to `rebase`. Configure the
`OPENAI_API_KEY` Actions secret before you run it.

The workflow accepts only a head branch in this repository. It applies the
selected strategy to the current base revision and head revision in a separate
checkout. A rebased branch uses `--force-with-lease` against its captured head
revision. If Git reports no merge conflicts, the merge strategy stops without a
commit.

If conflicts exist, `resolve-merge-conflicts.ts` receives the exact conflict
paths and both immutable revisions. Its exclusive agent task can read and edit
the checkout. The OpenCode policy denies shell commands, external paths, and
project configuration. The task must edit only the supplied conflict files.

After Seqlane finishes, the workflow rejects new files and edits outside the
initial conflict list. It also rejects unresolved conflicts and Git whitespace
errors. It rejects staged Git conflict markers. A rebase can use no more than
five conflict-resolution attempts. The workflow stops OpenCode before it
configures GitHub credentials. Then it creates one merge commit or pushes the
rebased history.

The workflow checks the captured base revision before it pushes. The exact
force-with-lease protects the remote head revision. A base update after that
check can make the result stale, but it cannot overwrite the base branch.

The workflow downloads the pinned OpenCode release archive over HTTPS. It
checks the archive SHA-256 before extraction. It does not run a remote installer
script.

The workflow configures `Seqlane conflict resolver` as the Git committer. A
merge commit uses that name as its author. A rebase preserves each original
commit author and records that name as its committer.

`all-features.ts` is the compact feature tour. It uses typed input/output,
shared and exclusive workspaces, isolated/reused/branched sessions, explicit
dependencies, whole/nested/literal bindings, references, Studio observability
selections, fan-out/fan-in, mechanical gates, a task-backed repeat
postcondition, and a one-iteration repeat. The two branch lanes can run
concurrently, so the example stays small and fast.

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/all-features.ts \
  --input '{"topic":"Seqlane","focus":"typed workflows"}' \
  --runtime http://127.0.0.1:4096
```
