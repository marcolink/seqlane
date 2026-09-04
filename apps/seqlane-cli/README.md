# Seqlane CLI

## Discover and plan workflows

Repository workflows use `.seqlane/workflows/*.json` below the current working
directory. User workflows use `~/.config/seqlane/workflows/*.json`. Each JSON
file contains one descriptor:

```json
{
  "name": "review",
  "moduleSpecifier": "./review.ts",
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
seqlane plan ./examples/minimal-workflow.ts --output json
seqlane run repository:review --input '{"topic":"Seqlane"}'
```

Repository and user workflow modules are trusted local authoring code. The plan
command can import and evaluate the selected module to compile its Plan. It is
not a sandbox for untrusted workflow source.

Direct file and module references remain supported by `seqlane run` and
`seqlane plan`. A module reference can include an export name as
`<module-specifier>#<export-name>`.

## Operational host

Start the foreground Mastra operational host for all discovered workflows:

```sh
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

Run-control commands use the same host. Set `--server-url` to use an existing
host; without it, the command owns a local host for its lifetime:

```sh
seqlane status <run-id> --server-url http://127.0.0.1:4111
seqlane cancel <run-id> --server-url http://127.0.0.1:4111
```

`run` prints the Work and Run identifiers before progress output. It owns a
loopback operational host by default and uses the same Mastra server path as
`run --server-url`, which connects to an existing host. `status` reads the
canonical Mastra run record. `cancel` sends the idempotent Mastra cancellation
request.

## Community Studio

Start the upstream Mastra Community Studio:

```sh
seqlane studio
```

By default, the Studio connects to the Seqlane/Mastra server at
`http://127.0.0.1:4111/api`. Configure the UI and server endpoints when needed:

```sh
seqlane studio --port 3001 --server-port 4112
```

The command launches the pinned Community Studio CLI. Seqlane does not bundle,
rebrand, or embed a separate Studio application.

## Dry run

Print the calculated, execution-safe Plan without connecting to the runtime or
running any tasks:

```sh
seqlane run ./examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096 \
  --dry
```

The command writes the Plan as formatted JSON to stdout. `--runtime` is
optional for dry runs and local-only workflows. When omitted, the CLI uses the
local runtime profile; workflows with agent tasks must provide an OpenCode
runtime URL.

Local-only workflows can execute without a runtime profile:

```sh
seqlane run ./examples/local-only.ts \
  --input '{"value":"local"}'
```

For non-interactive execution, use CI output for concise line-by-line progress
and actionable failures:

```sh
seqlane run ./examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096 \
  --output ci
```

CI output does not print invocation input, transient output, or routine tool
activity. Use `--record` with `replay --output json` when a complete
machine-readable event stream is needed in addition to the visible CI log.

## File-accessing workflows

`workspace: "shared"` permits overlap with other shared tasks;
`workspace: "exclusive"` serializes workspace use. The policy is not a
filesystem permission boundary. The workflow input does not grant file access;
configure executor permissions before starting a non-interactive Run.

```sh
seqlane run ./examples/code-review.ts \
  --input '{"repository":"/path/to/repository","target":"last-commit"}' \
  --runtime http://127.0.0.1:4096 \
  --workspace /path/to/repository
```

Runs use isolated executor sessions by default. Independent tasks can overlap
only when their session, DAG, global capacity, and workspace policies permit it.

When the configured OpenCode runtime also serves its browser UI, human terminal
output adds a per-task `Session UI` link. CI and JSON output print the URL to
stderr so their stdout remains machine-readable.

## Recording and replay

Recording is explicit and writes a new, local newline-delimited JSON file:

```sh
seqlane run ./examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096 \
  --record ./seqlane-recording.jsonl
```

The CLI warns on stderr before writing execution data. The file contains one
generic `seqlane.recording` header with the CLI workflow ID, followed by the
ordered canonical `SeqlaneExecutionEvent` JSON lines. It is bounded to 10 MiB
and 10,000 events; an existing path is rejected.

Replay is read-only. It validates the header, canonical events, run identity,
and contiguous sequence before sending the same output. It never loads or
executes a workflow:

```sh
seqlane replay ./seqlane-recording.jsonl --output human
```

## Development

Build the workspace before you run the repository CLI entrypoint:

```sh
pnpm build
```

Then run the Community Studio from the repository root:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js studio --port 57694
```

Run a local workflow with the same entrypoint:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096
```

Run the CLI boundary tests after a build:

```sh
pnpm exec nx test:e2e seqlane-cli
```
