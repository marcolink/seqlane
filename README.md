# Seqlane

Seqlane runs typed TypeScript workflows. Define tasks with Seqlane contracts,
then run the workflow with the CLI.

## Project status

Seqlane is under active development. Breaking changes can occur while its
contracts and package boundaries evolve.

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
