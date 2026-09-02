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

`code-review.ts` is an autonomous code-review workflow. It reviews either the
last commit or all uncommitted changes, then runs correctness, maintainability,
and risk lanes in parallel before producing a five-axis rating. It instructs
the agent to use only read-only Git inspection commands. The current OpenCode
tasks use `workspace: "shared"` because the author asserts they may overlap.
This is not a read-only workspace boundary; configure the runtime accordingly.

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/code-review.ts \
  --input '{"repository":"/path/to/repository","target":"last-commit"}' \
  --runtime http://127.0.0.1:4096 \
  --workspace /path/to/repository
```

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
