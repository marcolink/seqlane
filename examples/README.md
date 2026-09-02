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

Workflow files run as local Node.js code in the runner process. Run only files
you trust. TypeScript files use Node.js 24 native type stripping; use
erasable TypeScript syntax or compile unsupported syntax to `.mjs`.

Examples may import `@seqlane/core` and `zod`. When copying an
example to another project, install those dependencies there.

`pr-code-review.ts` is an autonomous pull-request code-review workflow. It
compares explicit base and head revisions, using the pull-request title and
description as untrusted author-supplied context. It runs correctness,
maintainability, and risk lanes in parallel before producing a five-axis
rating. It instructs the agent to use only read-only Git inspection commands.
The current OpenCode tasks use `workspace: "shared"` because the author asserts
they may overlap. This is not a read-only workspace boundary; configure the
runtime accordingly.

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/pr-code-review.ts \
  --input '{"repository":"/path/to/repository","baseRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pullRequest":{"title":"Add automated review","description":"Run Seqlane for every pull request."}}' \
  --runtime http://127.0.0.1:4096 \
  --workspace /path/to/repository
```

## Automated pull-request review

`.github/workflows/seqlane-code-review.yml` runs the code-review example for
non-draft pull requests from branches in this repository. Configure the
`OPENAI_API_KEY` Actions secret to enable it. Without the secret, the workflow
reports a successful skip.

The workflow builds Seqlane from the trusted base revision and reviews the
explicit base-to-head range in a separate checkout. It does not execute package
installation or repository scripts from the pull request. OpenCode ignores
project runtime configuration during the review and receives a read-only tool
policy. The workflow updates one marked pull-request comment with the report
and fails its job when the report verdict is `request-changes`.
