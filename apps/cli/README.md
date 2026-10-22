# Seqlane CLI

Use Node.js 24 or later. Oclif owns command parsing and help. Effect v4 owns
application execution and resource cleanup behind those commands.

Seqlane provides the workflow layer. It defines typed tasks, dependencies,
schemas, sessions, workspace policy, and workflow outputs.

Every run selects a runtime profile. The runtime layer executes tasks and owns
models, tools, permissions, processes, and adapter configuration. The built-in
`local` profile runs deterministic tasks without an adapter. Agent tasks need a
configured adapter runtime, such as OpenCode.

## Published and local-development entrypoints

The published package includes `bin/run.js` and production output. Development
entrypoints, test workers, and fixture programs stay in the repository.

Use the published `seqlane` binary when the CLI is installed from npm. Use the
repository entrypoint when you are developing this workspace. Build the
workspace before using the local entrypoint.

| Operation      | Published CLI            | Local development                                   |
| -------------- | ------------------------ | --------------------------------------------------- |
| Help           | `seqlane --help`         | `pnpm exec node apps/cli/bin/run.js --help`         |
| Run a workflow | `seqlane run <workflow>` | `pnpm exec node apps/cli/bin/run.js run <workflow>` |

The flags and arguments are the same in both columns.

## Run a workflow

`run` accepts an explicit file reference or a package module reference with an
export name: `<module-specifier>#<export-name>`. The selected export must be an
authored Seqlane workflow; raw Plans and Plan factories are not supported
entrypoints.

Local-only workflows do not need a runtime profile:

```sh
seqlane run ./workflows/local-only-example/workflow.ts \
  --input '{"value":"local"}'
```

Select an adapter when an agent task needs one:

```sh
seqlane run ./workflows/minimal-example/workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --adapter opencode
```

OpenCode uses managed mode by default. The run starts and owns a private
service at `127.0.0.1` with port `0`. Port `0` selects an ephemeral port. Use
`--opencode-host` or `--opencode-port` to change this endpoint.

Use `--opencode-mode external` to connect to an existing loopback service.
External mode requires `--opencode-host` and `--opencode-port`. Its port must
be from `1` through `65535`. The run never starts or stops that service. Codex
uses its native discovery defaults.

Use `--input-file <path>` for JSON input from a file. The CLI accepts one input
source per run, and input files have a 1 MiB limit.

For non-interactive execution, use CI output for concise line-by-line progress
and actionable failures:

```sh
seqlane run ./workflows/minimal-example/workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --adapter opencode \
  --output ci
```

CI output prints complete invocation input, result, activity, and model
observation events as JSON lines. Transient output has its own channel. Use
`run --json` for one final machine-readable result.

## File-accessing workflows

`workspace: "shared"` permits overlap with other shared tasks;
`workspace: "exclusive"` serializes workspace use. The policy is not a
filesystem permission boundary. The workflow input does not grant file access;
configure executor permissions before starting a non-interactive run.

```sh
seqlane run ./workflows/code-review/workflow.ts \
  --input '{"repository":"owner/repository","baseBranch":"main","baseRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pullRequest":{"number":123,"title":"Add automated review","description":"Run Seqlane for every pull request."}}' \
  --adapter opencode \
  --workspace /path/to/repository
```

Runs use isolated executor sessions by default. Independent tasks can overlap
only when their session, DAG, global capacity, and workspace policies permit it.

When the configured OpenCode runtime also serves its browser UI, the terminal
renderers do not show its session URL. Final JSON results contain no progress.
Signal cancellation results preserve the received signal, for example
`Run cancelled after SIGINT` or `Run cancelled after SIGTERM`.
The CLI sends one cancellation request and waits up to 35 seconds for the
runner to clean up its owned processes. If cleanup does not complete, the CLI
stops only process groups whose identity the runner registered and the CLI
revalidated. Cancellation exits with status `130`.

## Hosted history and inspection

Start the optional loopback host when you need retained history:

```sh
seqlane unstable_serve --storage-url file:./.seqlane/operations.db
curl http://127.0.0.1:4111/healthz
curl http://127.0.0.1:4111/readyz
curl http://127.0.0.1:4111/api/workflows
```

Select a workflow key from that list. Start returns immediately with a run
reference. For example, use the returned key in place of `repository:example`:

```sh
curl -X POST 'http://127.0.0.1:4111/api/workflows/repository%3Aexample/start-async' \
  -H 'content-type: application/json' \
  --data '{"version":1,"runId":"example-run","workId":"example-work","input":{}}'
curl 'http://127.0.0.1:4111/api/workflows/repository%3Aexample/runs/example-run'
curl 'http://127.0.0.1:4111/api/workflows/repository%3Aexample/runs/example-run/events?version=1&afterSequence=0&limit=100'
curl 'http://127.0.0.1:4111/api/workflows/repository%3Aexample/runs/example-run/trace'
```

Use the event response's `nextSequence` as the next cursor. Check `gap` and
`completeness` before treating inspection as complete. Run lists use bounded
`limit` and `cursor` pagination with `version=1`. Cancellation is idempotent for
the same run.

MCP clients connect to `/api/mcp/seqlane-workflows/mcp` on the same host.
Workflow tools use the same versioned input envelope and run program as HTTP.
The host accepts only loopback access and validated browser origins.

The new database starts a new history. Existing history files stay untouched.
Run one host per database. Use its HTTP or MCP endpoint for concurrent clients.
After a crash, unfinished runs become interrupted. Restart never repeats their
external actions. Standalone `run` creates no history database.

Use the terminal UI during a run. To inspect an existing canonical recording,
use replay; it does not execute the workflow:

```sh
seqlane unstable_replay ./seqlane-recording.jsonl --output human
seqlane unstable_replay ./seqlane-recording.jsonl --events ndjson
```

For an external trace viewer, configure an OTLP receiver such as your existing
observability collector. Set `SEQLANE_TELEMETRY` with `endpoint` and an explicit
`payloadPolicy` of `metadata` or `full`. Remote export is optional; canonical
host history and run results do not depend on receiver availability.

## Development

Build the workspace before you run the repository CLI entrypoint:

```sh
pnpm build
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
