# Seqlane

Seqlane is a typed TypeScript workflow runtime for software-engineering work.
Define tasks with Zod schemas, connect them in a static graph, and run the
graph from the CLI.

Workflows can combine:

- agent tasks that use a configured runtime;
- deterministic tasks that run in the Seqlane process; and
- local process tasks that use direct executable arguments.

Seqlane checks task inputs and outputs at runtime. The workflow graph also
declares task dependencies, session use, and workspace coordination.

> Seqlane is in active development. The current repository is not a published
> package. Use the checkout instructions below to run it.

## Install the CLI from this repository

Use Node.js 24 or later and pnpm 10.33 or later.

```sh
git clone https://github.com/marcolink/seqlane.git
cd seqlane
pnpm install --frozen-lockfile
pnpm build
```

Run the CLI from the repository root with this command:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js --help
```

The examples below use the same command prefix. A future published CLI can
replace the prefix with `seqlane`.

## Write a workflow

Create `workflow.ts` in the repository root:

```ts
import { createFlow, defineAgentTask } from "@seqlane/core";
import { z } from "zod";

const input = z.object({ topic: z.string().min(1) });
const output = z.object({ answer: z.string() });

const answerTask = defineAgentTask({
  id: "answer-topic",
  input,
  output,
  goal: ({ topic }) => `Write a concise answer about ${topic}.`,
  instructions: ["Return only the answer."],
});

export default createFlow({
  id: "answer-topic",
  input,
  output,
})
  .task("answer", answerTask, ({ input }) => input)
  .output(({ tasks }) => tasks.answer.output)
  .define();
```

The workflow export must be the default export when you pass a file without an
export name. Use `workflow.ts#namedExport` for a named export. The CLI accepts
`.ts`, `.mts`, `.js`, and `.mjs` workflow files.

### Add local work

Use `defineTask` for deterministic code. It does not call a model.

```ts
import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const input = z.object({ value: z.string() });
const output = z.object({ value: z.string() });

const localTask = defineTask({
  id: "copy-value",
  input,
  output,
  execute: async ({ input }) => input,
});

export default createFlow({ id: "local", input, output })
  .task("copy", localTask, ({ input }) => input)
  .output(({ tasks }) => tasks.copy.output)
  .define();
```

Use `defineShellTask` when a task needs a local process. Seqlane passes the
executable and argument list directly. It does not invoke a shell.

See the [workflow examples](examples/README.md) and the
[`@seqlane/core` guide](libs/seqlane-core/README.md) for sessions, branches,
validators, references, and workspace policies.

## Run a workflow

### Inspect the Plan

Compile a workflow without starting a runtime, calling a model, or running a
task:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js plan ./workflow.ts \
  --input '{"topic":"Seqlane"}'
```

Use `--output json` when another tool needs the Plan result.

### Run a local-only workflow

The included local-only example does not need an agent runtime:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run ./examples/local-only.ts \
  --input '{"value":"local"}'
```

### Run an agent workflow

Agent tasks need a configured runtime adapter. The following example uses an
OpenCode server.

Start OpenCode in one terminal:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

Set the adapter configuration in the terminal that runs Seqlane:

```sh
export SEQLANE_RUNTIME_ADAPTER_CONFIG='{"adapter":"opencode","url":"http://127.0.0.1:4096"}'
```

Run the workflow in that terminal:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run ./workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime opencode
```

The `--runtime` value is an opaque profile ID. It is not a URL, and the CLI
does not infer the adapter from it. The adapter configuration belongs to the
Seqlane process or operational server.

Use `--input-file <path>` for JSON input from a file. The CLI accepts one input
source per run, and input files have a 1 MiB limit.

## Use the CLI

The main commands are:

| Command              | Use                                                |
| -------------------- | -------------------------------------------------- |
| `run <workflow>`     | Execute one workflow.                              |
| `plan <workflow>`    | Compile a Plan without execution.                  |
| `list`               | List repository and user workflow descriptors.     |
| `serve`              | Start a persistent local operational server.       |
| `studio`             | Start Community Studio with an operational server. |
| `status <run-id>`    | Read a run from an operational server.             |
| `cancel <run-id>`    | Cancel a run on an operational server.             |
| `replay <recording>` | Replay a local execution recording.                |

Run `--help` on any command for all flags:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run --help
pnpm exec node apps/seqlane-cli/bin/run.js serve --help
```

`run` owns a loopback operational server for the duration of a run. Use
`--server-url` to attach to an existing loopback server. Use `serve` when you
need multiple runs, persistent run inspection, MCP access, or Studio access.

### Discover reusable workflows

Put repository workflow descriptors in `.seqlane/workflows/*.json`. Put user
workflow descriptors in `~/.config/seqlane/workflows/*.json`.

```json
{
  "name": "review",
  "moduleSpecifier": "./review.ts",
  "exportName": "default",
  "description": "Review a change"
}
```

The module path is relative to the descriptor file. List discovered workflows:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js list
```

Use `repository:review` or `user:review` when both scopes contain the same
name. An unqualified name works only when it is unique.

### Use persistent operations

Start a local operational server in one terminal:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js serve
```

The default server is `http://127.0.0.1:4111`. It stores Mastra run data in
`.seqlane/mastra.db` and exposes the registered workflows through the local
MCP endpoint.

In another terminal, run a registered workflow and inspect its run:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run repository:review \
  --input '{"topic":"Seqlane"}' \
  --runtime opencode \
  --server-url http://127.0.0.1:4111

pnpm exec node apps/seqlane-cli/bin/run.js status <run-id> \
  --server-url http://127.0.0.1:4111
```

Start Community Studio against the same server:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js studio \
  --server-url http://127.0.0.1:4111
```

The server and Studio accept loopback HTTP URLs only. See the
[CLI guide](apps/seqlane-cli/README.md) for MCP, recording, output modes,
server storage, and run-control details.

## Safety and execution rules

Workflow files run as trusted local Node.js code in the runner process. Run
only workflow files that you trust.

Agent permissions belong to the configured runtime. Workspace policy in a
workflow coordinates task scheduling; it does not grant filesystem or shell
access.

Local process tasks use awaited, foreground, non-interactive commands with
bounded output. A nonzero process exit code is typed task output. Spawn,
timeout, cancellation, and output-limit errors reject the task.

## Repository development

Install dependencies and enable the native hooks in a worktree:

```sh
pnpm install --frozen-lockfile
pnpm hooks:install
```

Run the main local checks:

```sh
pnpm format:check
pnpm docs:validate
pnpm lint
pnpm typecheck
pnpm test
```

The [documentation index](docs/index.md) links to the project documentation.
The [SDLC index](docs/sdlc/index.md) contains product requirements,
architecture decisions, technical specifications, and implementation tasks.
