# Codex

The Codex adapter starts and closes a local Codex app-server process for each
run. It requires a workspace.

```sh
seqlane run ./workflow.ts --input '{}' --adapter codex --workspace .
```

Codex finds the `codex` executable on `PATH`. `seqlane run` has no
adapter-specific executable flag.

Codex supports model selection, structured output, session reuse, checkpoint
branches, and activity events. Each session also appears as a task in the
Codex app. The adapter does not provide a browser session URL.
