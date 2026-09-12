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

> Seqlane is in active development. Breaking changes can occur while its
> contracts and package boundaries evolve.

## Workflow layer and runtime layer

Seqlane is the workflow layer. It defines typed tasks, task dependencies,
schemas, sessions, workspace policy, and workflow outputs.

Every run also selects a runtime profile. The runtime layer executes tasks and
owns models, tools, permissions, processes, and adapter configuration.

The built-in `local` profile runs deterministic tasks without an adapter. An
agent task needs a configured adapter runtime, such as OpenCode. The workflow
does not contain the adapter URL or its credentials.

Choose the runtime profile when you start a run or call the MCP server:

```text
workflow layer:  workflow.ts + runtime profile: local
workflow layer:  workflow.ts + runtime profile: opencode
```

This separation keeps the same workflow portable across runtime environments.

## Install Seqlane

Use Node.js 24 or later and pnpm 10.33 or later.

Install the CLI globally:

```sh
pnpm add --global seqlane
```

For a project-local installation, add the CLI and workflow dependencies:

```sh
pnpm add --save-dev seqlane
pnpm add @seqlane/core zod
```

Run a project-local CLI with `pnpm exec seqlane`. Run a global installation
with `seqlane`.

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
seqlane plan ./workflow.ts \
  --input '{"topic":"Seqlane"}'
```

Use `--output json` when another tool needs the Plan result.

### Run a local-only workflow

The included local-only example does not need an agent runtime:

```sh
seqlane run ./examples/local-only.ts \
  --input '{"value":"local"}'
```

### Run an agent workflow

`run` defaults to the `local` runtime profile. Local-only workflows do not need
adapter configuration. Agent tasks need a configured runtime adapter and an
agent runtime profile. The following example uses OpenCode.

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
seqlane run ./workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime opencode
```

The `--runtime` value is an opaque profile ID. It is not a URL, and the CLI
does not infer the adapter from it. The adapter configuration belongs to the
Seqlane process or operational server.

Use `--input-file <path>` for JSON input from a file. The CLI accepts one input
source per run, and input files have a 1 MiB limit.

## Choose an access pattern

Use one-shot CLI execution when one process needs one workflow result:

```sh
seqlane run my-workflow.js --input '{}'
```

The CLI starts a temporary loopback operational server for the run, prints the
result, and closes the server. Add `--runtime opencode` and configure
`SEQLANE_RUNTIME_ADAPTER_CONFIG` when the workflow contains agent tasks.

Use the MCP access pattern when an MCP client, Studio, or multiple runs need a
persistent server:

Local-only workflows do not need adapter configuration. For agent workflows,
set the adapter configuration before you start the server:

```sh
export SEQLANE_RUNTIME_ADAPTER_CONFIG='{"adapter":"opencode","url":"http://127.0.0.1:4096"}'
seqlane serve
```

Connect an MCP client to
`http://127.0.0.1:4111/api/mcp/seqlane-workflows/mcp`. The server registers
discovered workflows as tools. For example, the `repository:review` workflow
is available as `run_repository:review` with arguments like these:

```json
{
  "input": { "topic": "Seqlane" },
  "runtime": { "id": "opencode" }
}
```

The MCP server owns adapter configuration. The `runtime.id` value selects the
profile for a call; it does not contain the adapter URL.

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
seqlane run --help
seqlane serve --help
```

Use `--server-url` to attach `run`, `status`, or `cancel` to an existing
loopback server. Use `serve` when you need multiple runs, persistent run
inspection, MCP access, or Studio access.

### Discover reusable workflows

Put repository workflow descriptors in `.seqlane/workflows/*.json`. Put user
workflow descriptors in `~/.config/seqlane/workflows/*.json`.

```json
{
  "name": "review",
  "moduleSpecifier": "../../review.ts",
  "exportName": "default",
  "description": "Review a change"
}
```

The module path is relative to the descriptor file. This example assumes that
`review.ts` is in the project root. List discovered workflows:

```sh
seqlane list
```

Use `repository:review` or `user:review` when both scopes contain the same
name. An unqualified name works only when it is unique.

### Use persistent operations

Start a local operational server in one terminal:

```sh
export SEQLANE_RUNTIME_ADAPTER_CONFIG='{"adapter":"opencode","url":"http://127.0.0.1:4096"}'
seqlane serve
```

The default server is `http://127.0.0.1:4111`. It stores Mastra run data in
`.seqlane/mastra.db` and exposes the registered workflows through the local
MCP endpoint.

In another terminal, run a registered workflow and inspect its run:

```sh
seqlane run repository:review \
  --input '{"topic":"Seqlane"}' \
  --runtime opencode \
  --server-url http://127.0.0.1:4111

seqlane status <run-id> \
  --server-url http://127.0.0.1:4111
```

Start Community Studio against the same server:

```sh
seqlane studio \
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
