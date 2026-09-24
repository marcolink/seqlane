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

The workflow input is JSON. Pass a JSON value with `--input`, read it from a
file with `--input-file`, or set individual fields with `--input.<path>`. Use
one input source per run. Each explicit source has a 1 MiB limit. With no input
flag, the CLI validates `{}`.

```sh
seqlane run ./workflow.ts \
  --input '{"topic":"Seqlane"}'
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

## General flags

### `--input` (`-i`)

Pass the workflow input as one JSON value. Use this flag, `--input-file`, or
dotted input flags, but do not combine input sources.

```sh
seqlane run ./workflow.ts \
  --input '{"topic":"Seqlane"}'
```

### `--input-file`

Read the workflow input from a JSON file. The file can be at most 1 MiB. Use
`-` to read stdin. Stdin is read only when this flag is present. Use this flag,
`--input`, or dotted input flags, but do not combine input sources.

```sh
seqlane run ./workflow.ts \
  --input-file ./input.json
```

Read JSON from stdin explicitly:

```sh
printf '{"topic":"Seqlane"}' | seqlane run ./workflow.ts --input-file -
```

### `--input.<path>`

Set one field in a generated input object. Repeat the flag to set more fields.
Separate nested object keys with dots. Each path must have 1 to 64 non-empty
segments. Numeric segments are property names, not array indexes. Dots and
equals signs cannot appear inside a property name.

Values that are valid JSON use their JSON type. Other values are strings. To
pass the string `true`, use the JSON string value `--input.state '"true"'`.
Pass arrays and objects as JSON values. Use the equals form when a string
begins with `--`.
Duplicate fields and parent/child path conflicts fail.

```sh
seqlane run ./workflow.ts \
  --input.name Marco \
  --input.profile.age 42 \
  --input.tags '["cli","workflow"]'
```

This creates `{"name":"Marco","profile":{"age":42},"tags":["cli","workflow"]}`.
Use `--input` or `--input-file` for arrays at the input root or property names
that contain dots or equals signs.

### `--adapter`

Select the adapter for agent tasks. Supported values are `opencode` and
`codex`. Omit this flag for deterministic workflows.

```sh
seqlane run ./workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --adapter opencode
```

### `--workspace`

Set the workspace path for tasks that access files.

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --workspace ./repository
```

### `--output`

Select terminal output: `auto`, `human`, or `ci`. The default is `auto`.
Human output requires a terminal with input and output. It does not ask the
user questions.

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --output ci
```

Human output keeps fixed task metadata, such as the model, workspace, and
session policy, visible when available. It also shows complete task input and
result values, plus the latest full activity payload for each activity ID.
These values remain visible after completion and are not redacted or
truncated. They can contain sensitive task data. Completed tasks also show four
compact summary lines: fixed metadata; total tokens and cost;
input/output/reasoning/cache-read/cache-write token counts; and
  per-tool/per-skill counts. Cache counts remain separate from the total when
  the source does not provide a total.
Duration stays right-aligned with the task title. ANSI colors mute keys and
separators while giving values stronger contrast.

CI output writes each task input, result, and activity event as a full JSON
line, including progress events. These lines are not redacted or truncated.
Transient output remains on its separate channel.

### `--json`

Write one final JSON result. You cannot combine this flag with `--dry`.

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --json
```

### `--dry`

Print the calculated Plan without executing workflow tasks. You cannot combine
this flag with `--json`.

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --dry
```

### `--help`

Show command help.

```sh
seqlane run \
  --help
```

## Classifier flags

Classifier tasks use one URL and model for the run. Supply both flags when a
task calls the classifier. A classifier-only workflow does not need `--adapter`.
For a workflow with both agent and classifier tasks, supply `--adapter` for the
agent tasks and the classifier flags for the classifier tasks. Read
[Classifier tasks](/authoring-workflows/classifier-tasks) for authoring and
result details.

::: tip When these flags are needed

These flags are only relevant if your workflow contains at least one classifier
task. Workflows without classifier tasks need neither flag. Supply both when a
run executes a classifier task.

:::

### `--classifier-url`

Set the classifier endpoint URL. Remote endpoints require HTTPS. HTTP is
allowed only for a loopback server.

### `--classifier-model`

Set the model ID sent with classifier requests. Supply this flag together with
`--classifier-url`.

```sh
seqlane run ./classifier-workflow.ts \
  --input '{"change":"example change"}' \
  --classifier-url https://api.typesafe.ai/v1/systemone \
  --classifier-model jev-latest \
  --json
```

For a workflow that also has agent tasks:

```sh
seqlane run ./mixed-workflow.ts \
  --input '{"change":"example change"}' \
  --adapter opencode \
  --workspace ./repository \
  --classifier-url https://api.typesafe.ai/v1/systemone \
  --classifier-model jev-latest
```

Replace each workflow path with your authored workflow. The classifier
connection is selected once for the run; it is not part of workflow source or
the Plan. `--dry` does not call the classifier and requires neither classifier
flag nor an API key. Without a connection, execution fails when a classifier
task requests one.

::: info API key

For HTTPS or a non-loopback endpoint, set `SEQLANE_CLASSIFIER_API_KEY` in the
shell running Seqlane. The CLI has no token flag. Keep the key out of workflow
source and command arguments.

:::

## OpenCode adapter-specific flags

Codex has no adapter-specific flags. Use `--workspace` with `--adapter codex`.

### `--opencode-mode`

This flag requires `--adapter opencode`. It accepts `managed` or `external`.
The default is `managed`.

Managed mode starts and stops a private OpenCode service. External mode uses an
existing OpenCode service. Seqlane does not start or stop the external service.

### `--opencode-host`

This flag requires `--adapter opencode`. Managed mode uses `127.0.0.1` by
default. External mode requires an explicit host. The host must be loopback.

### `--opencode-port`

This flag requires `--adapter opencode`. Managed mode uses port `0` by default.
Port `0` selects an ephemeral port. Managed mode accepts ports from `0` through
`65535`. External mode requires an explicit port and accepts ports from `1`
through `65535`.

Run a workflow with an external OpenCode service:

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --adapter opencode \
  --opencode-mode external \
  --opencode-host 127.0.0.1 \
  --opencode-port 4096
```
