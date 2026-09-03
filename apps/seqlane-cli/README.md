# Seqlane CLI

## Local Studio

From a packaged CLI, start a foreground, loopback-only Studio session:

```sh
seqlane studio
```

Run a workflow and forward its canonical execution events to that session:

```sh
seqlane run ./examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096 \
  --studio
```

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
optional for dry runs and required for execution.

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

Studio uses a fixed loopback port by default and has no descriptor or browser
bootstrap token. Studio forwarding is ordered and best effort; a Studio error
does not change workflow execution, terminal output, or the CLI exit status.

Studio state is transient. The foreground service stores run data in memory,
and stopping or restarting it erases the current run list and event buffer.

When the configured OpenCode runtime also serves its browser UI, human terminal
output adds a per-task `Session UI` link. CI and JSON output print the URL to
stderr so their stdout remains machine-readable.

Start Studio with one bounded, validated recording for read-only browser
inspection:

```sh
seqlane studio --replay ./seqlane-recording.jsonl
```

The command validates the file before startup and prints a browser URL with an
opaque replay identifier and `debug=1`. The recording path is not put in the
URL or API payload. Replay is local, non-persistent, does not alter live Studio
state, and cannot resume workflow execution.

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
and contiguous sequence before sending the same output and optional Studio
consumer stream. It never loads or executes a workflow:

```sh
seqlane replay ./seqlane-recording.jsonl --output human
seqlane replay ./seqlane-recording.jsonl --studio --studioPort 57695
```

## Development

Build the workspace before you run the repository CLI entrypoint:

```sh
pnpm build
```

Then run Studio from the repository root:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js studio --port 57694
```

Run a local workflow with the same entrypoint:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js run examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime http://127.0.0.1:4096 \
  --studio
```

Run the CLI boundary tests after a build:

```sh
pnpm exec nx test:e2e seqlane-cli
```
