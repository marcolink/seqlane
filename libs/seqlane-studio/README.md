# @seqlane/studio

Private local service for the Seqlane Execution Studio.

The service binds to loopback, accepts unauthenticated local copies of
canonical execution events, stores bounded in-memory run state, and serves
JSON snapshots and Server-Sent Events. It does not execute workflows or
control runs. A replay session can load one bounded recording at startup; it
is read-only, non-persistent, and does not add replay events to live state.

## Use the service

The CLI owns the normal lifecycle:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js studio \
  --port 57694
```

Start a local replay session:

```sh
pnpm exec node apps/seqlane-cli/bin/run.js studio \
  --replay ./seqlane-recording.jsonl
```

The printed browser URL contains an opaque `replay` identifier and `debug=1`.
The service validates the recording before listening and exposes its validated
events at `GET /api/replay/<replay-id>`. The URL and response never contain
the recording path. Replay cannot resume workflow execution.

Direct browser access is intentional for local development. The service keeps
run state in memory only, and stopping the foreground session removes the
current run list and event buffer.

## Public exports

- `@seqlane/studio` exports `startStudioSession` and
  `StudioRegistry`.
- `@seqlane/studio/protocol` exports browser-safe protocol types.

The service has no database, durable history, remote access, browser run
control, Mastra types, or executor-specific fields.
