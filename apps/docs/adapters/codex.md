# Codex

The Codex adapter starts and closes a local Codex app-server process for each
run. It requires a workspace.

```sh
seqlane run ./workflow.ts \
  --input '{}' \
  --adapter codex \
  --workspace .
```

Codex finds the `codex` executable on `PATH`. `seqlane run` has no
adapter-specific executable flag.

Codex supports model selection, structured output, session reuse, checkpoint
forks, activity events, and explicitly enabled user input. Each session also appears as a task in the
Codex app. The adapter does not provide a browser session URL.

For long turns, activity events can end with an explicit truncation notice.
The turn continues and can still return its final result.

Use [`--interactive`](../interactivity.md) to answer
questions during an agent task. The agent uses `ask_user` when required input
is missing or a skill requests it. Questions may contain text fields, single
choices, and text alternatives. The final task output schema stays unchanged.
The [Interactivity guide](../interactivity.md) covers setup, skill examples,
and terminal controls.

The default remains non-interactive. Input waits need a live terminal; they
cannot resume after a process restart. This mode does not approve permissions.
