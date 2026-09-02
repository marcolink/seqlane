# Seqlane

Seqlane runs typed TypeScript workflows. Define tasks with Seqlane contracts,
then run the workflow with the CLI.

## Project status

Seqlane is under active development. Breaking changes can occur while its
contracts and package boundaries evolve.

## Quickstart

### Install

Use Node.js 24 or later and pnpm 10.33 or later. In the current release,
Seqlane requires an available OpenCode runtime before it can run a workflow.

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
