# Seqlane CLI

Seqlane provides the workflow layer. It defines typed tasks, dependencies,
schemas, sessions, workspace policy, and workflow outputs.

Deterministic tasks run without an adapter. Agent tasks require an explicit
adapter, such as `--adapter opencode`. The adapter owns its models, tools,
permissions, processes, configuration, and authentication.

## Published and local-development commands

Use the published `seqlane` binary when the CLI is installed from npm. Use the
repository entrypoint when you are developing this workspace. Build the
workspace before using the local entrypoint.

| Operation          | Published CLI                | Local development                                       |
| ------------------ | ---------------------------- | ------------------------------------------------------- |
| Help               | `seqlane --help`             | `pnpm exec node apps/cli/bin/run.js --help`             |
| List workflows     | `seqlane list`               | `pnpm exec node apps/cli/bin/run.js list`               |
| Plan a workflow    | `seqlane plan <workflow>`    | `pnpm exec node apps/cli/bin/run.js plan <workflow>`    |
| Run a workflow     | `seqlane run <workflow>`     | `pnpm exec node apps/cli/bin/run.js run <workflow>`     |
| Start the server   | `seqlane serve`              | `pnpm exec node apps/cli/bin/run.js serve`              |
| Start Studio       | `seqlane studio`             | `pnpm exec node apps/cli/bin/run.js studio`             |
| Read a run         | `seqlane status <run-id>`    | `pnpm exec node apps/cli/bin/run.js status <run-id>`    |
| Cancel a run       | `seqlane cancel <run-id>`    | `pnpm exec node apps/cli/bin/run.js cancel <run-id>`    |
| Replay a recording | `seqlane replay <recording>` | `pnpm exec node apps/cli/bin/run.js replay <recording>` |

The flags and arguments are the same in both columns. For example, append
`--server-url http://127.0.0.1:4111` to either `status` command when using an
existing operational host.

## Discover and plan workflows

Repository workflows use `.seqlane/workflows/*.json` below the current working
directory. User workflows use `~/.config/seqlane/workflows/*.json`. Each JSON
file contains one descriptor:

```json
{
  "name": "review",
  "moduleSpecifier": "../../review.ts",
  "exportName": "default",
  "description": "Review a change"
}
```

The module reference is relative to its descriptor file. `seqlane list` reads
and validates descriptors without importing workflow modules:

```sh
seqlane list
seqlane list --output json
```

Use `repository:<name>` or `user:<name>` when a name exists in both scopes.
An unqualified name works only when it is unique. The `--repository-root` and
`--user-root` flags override the default descriptor roots.

`seqlane plan` loads and compiles one selected workflow. It never starts a run,
process, executor, or model:

```sh
seqlane plan repository:review --input '{"topic":"Seqlane"}'
seqlane plan ./workflows/minimal-example/workflow.ts --output json
```

Repository and user workflow modules are trusted local authoring code. The plan
command can import and evaluate the selected module to compile its Plan. It is
not a sandbox for untrusted workflow source.

`seqlane plan` can use discovered workflow names, direct files, and module
references. `seqlane run` accepts only one explicit local file or installed
package entrypoint. An entrypoint can include an export name as
`<module-specifier>#<export-name>`.
The selected export must be an authored Seqlane workflow; raw Plans and Plan
factories are not supported entrypoints.

Local run entrypoints support `.ts`, `.mts`, `.js`, and `.mjs`. Relative paths
resolve from the current directory. Installed packages must expose an
ESM-compatible public entrypoint. `repository:<name>`, `user:<name>`, and other
catalog aliases are not valid `run` references.

## Operational host

Start the foreground Mastra operational host for all discovered workflows:

```sh
seqlane serve
```

The host can start without adapter configuration for local-only workflows. For
agent workflows, set the adapter configuration before you start the host:

```sh
export SEQLANE_RUNTIME_ADAPTER_CONFIG='{"adapter":"opencode","url":"http://127.0.0.1:4096"}'
seqlane serve
```

The host uses durable LibSQL storage at `.seqlane/mastra.db`. It binds to
`127.0.0.1:4111` and exposes Mastra API routes, health at `/healthz`, and
readiness at `/readyz`:

```sh
seqlane serve --port 4112 --storage-url file:./.seqlane/mastra.db
```

Only loopback hostnames are accepted. The command loads and validates all
discovered workflow descriptors before the host starts listening. Press
`Ctrl-C` to close the HTTP server, flush tracing, and close storage.
Use `--hostname ::1` or `--hostname [::1]` for IPv6 loopback; the advertised
URL uses the required bracketed IPv6 form.

The host also exposes the registered workflows through Mastra Streamable HTTP
MCP at `http://127.0.0.1:<port>/api/mcp/seqlane-workflows/mcp`. This endpoint
is loopback-only. Each tool call uses `{ "input": <workflow-input> }`; add
`"runtime": { "id": "opencode", "workspace": "<path>" }` to select a
runtime profile. `runtime` is optional and defaults to `opencode`. Adapter
configuration remains server-owned.

Run-control commands use the same host. Set `--server-url` to use an existing
host; without it, the command owns a local host for its lifetime:

`--server-url` accepts only an unauthenticated HTTP loopback URL.

```sh
seqlane status <run-id> --server-url http://127.0.0.1:4111
seqlane cancel <run-id> --server-url http://127.0.0.1:4111
```

`status` reads the canonical Mastra run record. `cancel` sends the idempotent
Mastra cancellation request. `run` is separate from these host operations: it
never owns or attaches to a Seqlane operational host.

## Community Studio

Start the upstream Mastra Community Studio with an owned operational host:

```sh
seqlane studio
```

By default, this one command starts the Seqlane/Mastra host at
`http://127.0.0.1:4111`, waits for `/readyz`, then starts Studio at
`http://127.0.0.1:3000` against `/api`. It stops only those two processes when
the Studio exits or the command receives `SIGINT`/`SIGTERM`.

Configure the UI and owned server endpoints when needed:

```sh
seqlane studio --port 3001 --server-port 4112
```

The owned server endpoint flags are `--server-host` and `--server-port`. The
endpoint always uses HTTP loopback and the fixed `/api` route prefix. If
`--server-port 0` is used, Studio connects to the port assigned by the host.

Attach Studio to an existing loopback host without owning or stopping it:

```sh
seqlane studio --server-url http://127.0.0.1:4111
```

`--server-url` accepts only an unauthenticated HTTP loopback origin. In attach
mode, the command waits for `/readyz` before launching Studio. `seqlane serve`
remains headless and never starts Studio.

The command launches the pinned Community Studio CLI. Seqlane does not bundle,
rebrand, or embed a separate Studio application.

The operational host permits browser API requests only from HTTP loopback
origins, including the Studio UI at `http://localhost:3000`.
It also responds successfully at its root URL so Community Studio can detect
the local Mastra instance automatically.

## Plan without execution

Print the calculated Plan without connecting to the runtime or running tasks:

```sh
seqlane plan ./workflows/minimal-example/workflow.ts \
  --input '{"topic":"Seqlane"}'
```

The command writes the Plan in human-readable form by default. Use
`--output json` for machine-readable Plan output. The command does not need a
adapter, even when the workflow contains agent tasks.

Deterministic workflows can execute without an adapter:

```sh
seqlane run ./workflows/local-only-example/workflow.ts \
  --input '{"value":"local"}'
```

For non-interactive execution, use CI output for concise line-by-line progress
and actionable failures:

```sh
seqlane run ./workflows/minimal-example/workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --adapter opencode \
  --output ci
```

CI output does not print invocation input, transient output, or routine tool
activity. Use `run --json` for one final machine-readable result.

## File-accessing workflows

`workspace: "shared"` permits overlap with other shared tasks;
`workspace: "exclusive"` serializes workspace use. The policy is not a
filesystem permission boundary. The workflow input does not grant file access;
configure executor permissions before starting a non-interactive Run.

```sh
seqlane run ./workflows/code-review/workflow.ts \
  --input '{"repository":"owner/repository","baseBranch":"main","baseRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pullRequest":{"number":123,"title":"Add automated review","description":"Run Seqlane for every pull request."}}' \
  --adapter opencode \
  --workspace /path/to/repository
```

Runs use isolated executor sessions by default. Independent tasks can overlap
only when their session, DAG, global capacity, and workspace policies permit it.

The OpenCode adapter starts a private service only when agent work is requested;
it does not attach to a server URL or expose a browser session URL. Final JSON
results contain no progress.
Signal cancellation results preserve the received signal, for example
`Run cancelled after SIGINT` or `Run cancelled after SIGTERM`.

## Replay recordings

Standalone `run` does not create recordings, run history, or other persistent
Seqlane state. `replay` remains available for compatible recording files
supplied from earlier runs or another producer.

Replay is read-only. It validates the header, canonical events, run identity,
and contiguous sequence before sending the same output. It never loads or
executes a workflow:

```sh
seqlane replay ./seqlane-recording.jsonl --output human
```

Use the explicit event mode to write one canonical event per line:

```sh
seqlane replay ./seqlane-recording.jsonl --events ndjson
```

`--events ndjson` cannot be combined with `--output`. Replay applies the same
configured secret redactions as terminal output before writing event lines.
Configured values include `OPENAI_API_KEY`, `GITHUB_TOKEN`, and the
newline-delimited `SEQLANE_REDACT_VALUES` setting.

## Development

Build the workspace before you run the repository CLI entrypoint:

```sh
pnpm build
```

Then run Community Studio:

```sh
pnpm exec node apps/cli/bin/run.js studio --port 57694
```

Run a local workflow:

```sh
pnpm exec node apps/cli/bin/run.js run workflows/minimal-example/workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --adapter opencode
```

Run the CLI boundary tests after a build:

```sh
pnpm exec nx test:e2e cli
```
