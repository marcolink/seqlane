# Codex

The Codex adapter starts and closes a local Codex app-server process for each
run. It requires a workspace.

```sh
seqlane run ./workflow.ts --input '{}' --adapter codex --workspace .
```

Codex finds the `codex` executable on `PATH`. `seqlane run` has no
adapter-specific executable flag.

The adapter input accepts an optional `executable` value for a specific
executable. It must be an absolute path. If that path is unavailable, Codex
uses `PATH`. If it cannot find `codex`, the run fails.

Codex supports model selection, structured output, session reuse, checkpoint
branches, and activity events. Each session also appears as a task in the
Codex app. The adapter does not provide a browser session URL.
