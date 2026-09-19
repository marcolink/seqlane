---
outline: [2, 3]
---

# Run a workflow

Use `seqlane run` to execute one workflow.

```sh
seqlane run <workflow>
```

`<workflow>` is a direct TypeScript or JavaScript module reference. Use its
default export, or add `#<export-name>` to select a named export.

## Workflow artifacts

`seqlane run` imports one workflow module and runs its selected export. The
export must be an authored Seqlane workflow, created with
`createFlow(...).define()`.

```ts
export default createFlow({ id: "review", input, output })
  .task("inspect", inspect, ({ input }) => input)
  .output(({ tasks }) => tasks.inspect.output)
  .define();
```

The module can contain task definitions or import them from other modules. No
special Seqlane bundle format is required.

| Artifact | Example reference | Supported |
| --- | --- | --- |
| Local TypeScript or JavaScript module | `./workflows/review.ts` | Yes (`.ts`, `.mts`, `.js`, or `.mjs`) |
| Named export from a local module | `./workflows/review.ts#review` | Yes |
| Installed package module | `@acme/workflows/review#review` | Yes |
| Raw serialized Plan, Plan factory, JSON file, or descriptor name | — | No |

Use a package module when you distribute workflows. The package must expose an
importable module. The selected export still must be an authored workflow.

The workflow input is JSON. Pass it with `--input` or read it from a JSON file
with `--input-file`:

```sh
seqlane run ./workflow.ts --input '{"topic":"Seqlane"}'
```

Deterministic workflows run without an adapter. For agent tasks, select an
adapter with `--adapter`. A workflow stays independent of adapter connection
details.

Read [Adapters](/adapters/overview) to check adapter capabilities.

Use `--workspace` when tasks need repository files. Workspace access is a
runtime capability; the workflow's workspace policy coordinates tasks but does
not grant filesystem permissions.

The run validates workflow inputs, task outputs, and the workflow result. It
returns a failure when a boundary or task fails.

## Execution convention

Seqlane runs are non-interactive. A workflow must be self-contained: it cannot
ask the user questions or wait for approval, and it must include all required
input and permissions before the run starts. If a task needs unavailable input
or approval, the task fails and the run stops.

## Flags

### `--input` (`-i`)

Pass the workflow input as a JSON value. Use this flag or `--input-file`, but
not both.

```sh
seqlane run ./workflow.ts --input '{"topic":"Seqlane"}'
```

### `--input-file`

Read the workflow input from a JSON file. The file can be at most 1 MiB. Use
this flag or `--input`, but not both.

```sh
seqlane run ./workflow.ts --input-file ./input.json
```

### `--adapter`

Select the adapter for agent tasks. Supported values are `opencode` and
`codex`. Omit this flag for deterministic workflows.

```sh
seqlane run ./workflow.ts --input '{"topic":"Seqlane"}' --adapter opencode
```

### `--adapter-host` and `--adapter-port`

Use these flags only with `--adapter opencode`. They select the running
OpenCode server. The default host is `127.0.0.1`; it must be a loopback
address. The default port is `4096`.

```sh
seqlane run ./workflow.ts --input '{}' \
  --adapter opencode \
  --adapter-host 127.0.0.1 \
  --adapter-port 4096
```

Codex has no adapter-specific flags. Use `--workspace` with
`--adapter codex`.

### `--workspace`

Set the workspace path for tasks that access files.

```sh
seqlane run ./workflow.ts --input '{}' --workspace ./repository
```

### `--output`

Select terminal output: `auto`, `human`, or `ci`. The default is `auto`.
Human output requires a terminal with input and output. It does not ask the
user questions.

```sh
seqlane run ./workflow.ts --input '{}' --output ci
```

### `--json`

Write one final JSON result. You cannot combine this flag with `--dry`.

```sh
seqlane run ./workflow.ts --input '{}' --json
```

### `--dry`

Print the calculated Plan without executing workflow tasks. You cannot combine
this flag with `--json`.

```sh
seqlane run ./workflow.ts --input '{}' --dry
```

### `--help`

Show command help.

```sh
seqlane run --help
```
