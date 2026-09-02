# Seqlane Studio

Seqlane Studio is a foreground, local-only, read-only browser view for
Seqlane runs.

## Lifecycle

From a packaged CLI, start it with:

```sh
seqlane studio
```

From this repository, use:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js studio \
  --port 57694
```

The command stays in the foreground, binds only to loopback, and prints a
local browser URL. In another terminal, select that session when starting a
run:

```sh
seqlane run ./examples/minimal-workflow.ts \
  --input '{"topic":"Seqlane"}' \
  --runtime local \
  --studio
```

Studio keeps run snapshots and its bounded event stream in memory only. It has
no database, browser persistence, or durable history. Stopping or restarting
the foreground service erases the current run data.

The service consumes the same canonical Seqlane execution-event stream used by
CLI output and recording/replay flows.

The browser lists concurrent runs, displays the static Plan graph before
invocations exist, and overlays actual invocation instances and dependencies.
Planned nodes are not selectable; invocation nodes can be selected and
deselected by clicking the canvas or pressing Escape. Plan-node and
invocation identities remain separate. Nodes also
show available duration, token, cost, input/result-state, and validation
verdict metadata. Task nodes show their executor-neutral session policy and,
for reuse or branch, the source Plan node. The selected invocation inspector
shows validation identity,
issues, repeat-postcondition continuation, and bounded evidence. Full values
remain in the selected invocation inspector; large or restricted values show a
safe state instead. It does not edit graphs or control execution: there are no
cancel, retry, approval, or workflow commands.

Studio is intentionally unauthenticated for local development and binds only
to loopback. Studio forwarding is best effort and cannot change runner
execution, output, or exit status. A standalone Studio stays open until
stopped; `seqlane run --studio` stops only a temporary Studio it starts.

## Browser development with Vite

Run the Node Studio service and the browser development server as separate
processes:

```sh
# terminal 1
pnpm exec node apps/seqlane-cli/bin/run.js studio --port 57694

# terminal 2
pnpm --filter @seqlane/studio-app dev
```

Open `http://127.0.0.1:5173/`. Vite serves the React client, updates client
source changes through HMR, and proxies `/api` and `/health` to the default
loopback Studio service at `127.0.0.1:57694`. The Node service remains the
owner of live run data and the production static-file server.

Package commands:

```sh
pnpm --filter @seqlane/studio-app build
pnpm --filter @seqlane/studio-app preview
pnpm --filter @seqlane/studio-app typecheck
pnpm --filter @seqlane/studio-app test
```

`build` keeps the production client bundle at `dist/client`, which is the
bundle served by the Node Studio service. `preview` serves that built bundle
on `http://127.0.0.1:4173/`.

## Startup replay

Start Studio with one validated recording:

```sh
seqlane studio --replay ./seqlane-recording.jsonl
```

Open the printed URL. Studio loads the replay from its read-only endpoint and
keeps replay projection state separate from the live SSE projection. With the
printed `debug=1` hint, Play, Pause, Step, Reset, speed (1x/2x/4x), and Exit
replay controls are available. Replay is local, bounded, in-memory, and does
not post events or resume workflow execution. Exiting restores the live run
and invocation selection.
