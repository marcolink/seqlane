# Seqlane

Seqlane runs typed TypeScript workflows. Define tasks with Seqlane contracts,
then run the workflow with the CLI.

## Project status

Seqlane is under active development. Breaking changes can occur while its
contracts and package boundaries evolve.

## Repository layout

The `actions/` workspace contains JavaScript GitHub Actions. Each action is an
independent Nx project with its compiled entry point in its own `dist/` folder.

## Documentation

See the [documentation index](docs/index.md). Product requirements,
architecture decisions, technical specifications, and implementation tasks are
in the [SDLC corpus](docs/sdlc/index.md).

## Quickstart

### Install

Use Node.js 24 or later and pnpm 10.33 or later. Workflows with agent tasks
require an available runtime. Local tasks execute in the Seqlane process and do
not need a model session or model tokens.

```sh
pnpm add @seqlane/core zod
pnpm add --save-dev seqlane
```

## Repository development

Install dependencies and enable the native hooks in each worktree:

```sh
pnpm install --frozen-lockfile
pnpm hooks:install
```

`pnpm hooks:install` enables the versioned native Git hooks for the current
worktree. The pre-commit hook runs staged formatting and lint checks and
rejects files with additional unstaged edits. The
pre-push hook requires a clean worktree and runs the affected repository checks
against the merge-base with `origin/main`. Install dependencies separately in
each worktree; do not share `node_modules` between worktrees. It validates one
branch update at a time; tag-only or multi-ref pushes can use `--no-verify`.

To run the pre-push checks without pushing:

```sh
pnpm verify:push
```

Pull requests run the same affected quality gates in GitHub Actions, plus
affected builds, workflow validation, Action bundle-drift checks, and a single
`Merge gate` check suitable for branch protection.

### Author a workflow

Create `workflow.ts`:

```ts
import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const input = z.object({ topic: z.string() });
const output = z.object({ answer: z.string() });

const writeAnswer = defineTask({
  id: "write-answer",
  input,
  output,
  goal: ({ topic }) => `Write a concise answer about ${topic}.`,
});

export default createFlow({
  id: "answer-topic",
  input,
  output,
})
  .task("answer", writeAnswer, ({ input }) => input)
  .output(({ tasks }) => tasks.answer.output)
  .define();
```

### Run it

```sh
pnpm exec seqlane run ./workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096
```

Agent runs use the private `SEQLANE_RUNTIME_ADAPTER_CONFIG` environment
variable. Set one validated adapter configuration before you run the CLI:

```sh
export SEQLANE_RUNTIME_ADAPTER_CONFIG='{"adapter":"opencode","url":"http://127.0.0.1:4096"}'
```

To export runtime telemetry to Mastra Platform, also set the platform access
token, project ID, and observability endpoint:

```sh
export MASTRA_PLATFORM_ACCESS_TOKEN='...'
export MASTRA_PROJECT_ID='...'
export MASTRA_PLATFORM_OBSERVABILITY_ENDPOINT='https://observability.mastra.ai'
```

The `--runtime` value remains an opaque profile identifier. The CLI does not
infer the adapter from the value. An existing operational server must have its
own adapter configuration.

Use `--input-file <path>` instead of `--input` for JSON input up to 1 MiB.
Specify exactly one input source.

### Run a local task

Use `execute` instead of `goal` for deterministic work. The local task below
runs one executable with direct argv in the canonical workflow workspace:

```ts
const gitStatus = defineTask({
  id: "git-status",
  input: z.object({}),
  output: z.object({
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  workspace: "shared",
  execute: async (_input, { exec }) =>
    exec({ command: "git", args: ["status", "--porcelain=v1"] }),
});
```

Local tasks have no `session`, model selection, or token metrics. `exec` does
not invoke a shell. V1 supports only awaited, foreground, non-interactive
commands with bounded output. Local tasks do not provide Git helpers, Git
mutation APIs, shell support, background processes, or command policy.

The complete local-to-agent fixture is documented in
[`@seqlane/fixtures/local-git-status`](libs/seqlane-fixtures/README.md). The
later agent task receives the parsed `{ exitCode, stdout, stderr }` value as
typed input.

### Select a model

Models belong to sessions. New or branched sessions may select a model and
reasoning effort; reuse sessions inherit the source selection. Omit selection
to use the OpenCode default. See [core model selection](libs/seqlane-core/README.md#model-catalog).
