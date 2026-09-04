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
Inspection uses an isolated `openai/gpt-5.6-luna` session with high reasoning.
Each review lane uses an independent session with its configured OpenAI model
and reasoning level; the final summary uses an isolated
`openai/gpt-5.6-luna` session with high reasoning.
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

The workflow uses `pull_request_target`, runs the trusted workflow definition
from the base branch, and checks out the trusted Seqlane source from the base
revision. It checks out the pull-request head separately as the review target.

The workflow reads the pull request's configured base branch and immutable base
revision from the event, then reviews the explicit base-to-head range in a
separate checkout. A local workflow task validates the requested Git range and
collects bounded changed-file, diff-stat, unified-patch, and whitespace-check
evidence with explicit overflow metadata. Inspection and specialist lanes
review the supplied patch first and use targeted workspace reads only when the
patch is truncated or surrounding context is needed. Inspection produces
bounded requirements and evidence; specialist lanes run in independent
sessions and verify that evidence against the target workspace before the final
synthesis, which preserves the exact repository and base/head identity fields
from inspection. The workflow installs and builds the checked-out Seqlane
source, but does not install dependencies or execute repository scripts from
the separate review target. OpenCode ignores project runtime configuration
during the review and receives a read-only tool policy. The workflow updates
one marked pull-request comment with the report and records the report verdict
without failing the review job when it is `request-changes`. Configured secret
values are redacted from CI output, workflow summaries, and GitHub annotations.
The review runtime denies access outside the review workspace and blocks
environment files. Git writes the complete patch to a run-scoped temporary file
before the retained model-facing patch is bounded; the temporary file can be
larger than the 48,000-byte evidence limit and is removed after collection.

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
