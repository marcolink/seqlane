# Read-context hook

The project-local Codex hook checks Bash commands before execution. It denies
supported broad reads, unsafe paths, and read-like commands that it cannot
classify. Its response explains how to run the read-context workflow instead.

## Enable the hook

1. Use Node.js 24 or newer and run `pnpm install` at the repository root.
2. Run `pnpm build` before using the workflow command suggested by the hook.
3. Open this repository in Codex and run `/hooks`.
4. Trust the project hook configured in `.codex/hooks.json`.

The hook runs from TypeScript source with Node's built-in type stripping. It
does not need a package build. The workflow command uses the normal Seqlane CLI
build. The hook reads a `PreToolUse` event from standard input and writes the
hook decision as JSON to standard output.

## Use the workflow

When the hook denies a broad read, use the command in its reason to run
`./workflows/read-context/workflow.ts` with a focused question and the needed
paths. For example:

```sh
pnpm exec node apps/cli/bin/run.js run ./workflows/read-context/workflow.ts \
  --input '{"question":"Trace the workflow loading path","paths":["apps/cli/src"]}' \
  --adapter codex \
  --workspace "$PWD"
```

The workflow uses the configured retrieval tools and Codex adapter. The Codex
app-server must expose `gpt-6-luna` with medium reasoning. The hook
fails open for commands that it does not classify as read-like.
