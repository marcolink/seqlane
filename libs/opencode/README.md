# @seqlane/opencode-adapter

Internal SDK adapter for the Seqlane agent runtime. This package is public on
npm so `seqlane` can install it. Its exports are not a supported API. Workflow
authors use `@seqlane/core`; OpenCode SDK, session, and endpoint details stay
internal.

Agent tasks use the pinned OpenCode SDK with the selected endpoint, workspace,
and model configuration. The adapter does not receive, derive, merge, or
apply Seqlane per-task permission rules. Runtime configuration is authoritative
for tools, filesystem, shell, network, MCP, skills, and approvals.

The adapter submits structured-output prompts, observes activity, handles
cancellation, and converts unsupported interactive requests into the generic
non-interactive failure path. It never approves an interaction. Workspace
`shared` and `exclusive` policy is consumed by the Seqlane scheduler, not by
OpenCode permission configuration.

When the private adapter request contains a current Mastra workflow-step span,
the adapter adds one agent span, one model span per assistant message, and one
tool span per tool call. One validated event reducer, including legacy tool
lifecycle events, feeds both the existing
activity callbacks and native spans. The terminal response only reconciles
missing model coverage. Missing tracing, conflicting parent aliases, and span
failures do not change execution. Span metadata is bounded and excludes raw
prompts, transcripts, tool inputs, and tool outputs. OpenCode 1.18.27 does not
expose a verified cost unit, so native cost context is omitted.

OpenCode 1.18.27 leaks server listeners for each `/event` connection. The
adapter does not use that SSE route. It polls finite session history and pending
permission or question requests. The same validated reducer processes each
history event. Monitoring keeps one durable cursor per session, limits every
history page and drain, rejects pages that do not advance, and backs off while
the session is idle. Monitor responses are limited to 256 KiB before JSON
parsing. Their values also have bounded strings, nesting, and collection sizes.
Prompt completion performs one bounded tail drain. Prompt-mode completion also
reconciles newly persisted assistant message tool parts when the history stream
does not expose the activity event. Closing a run cancels active local
requests, interrupts the remote session, and waits for bounded cleanup.

OpenCode `skill` calls remain `TOOL_CALL` spans with `toolType: "skill"`. When
the event exposes a skill name, the adapter uses that bounded identity as the
span name, so traces distinguish individual skills without persisting skill
contents or metadata.

Structured output uses `auto` selection by default. A verified compatible
OpenCode version uses native JSON Schema output. Affected, unknown, malformed,
and prerelease versions use prompt-based JSON followed by local validation with
the task's existing output schema. Both strategies return the same typed task
value. The private adapter connection can explicitly select `native` or
`prompt`, and can set the bounded repair count.

If a native request causes the known persisted-message format readback failure,
the current invocation fails without replaying the task. The adapter marks that
runtime connection as native-unsafe, so later `auto` prompts use prompt mode
directly. This avoids repeating tools or workspace mutations. It does not repair
the already affected OpenCode session or restore native mode automatically.

Seqlane passes a normalized provider/model selection to this adapter. OpenCode
provider and model IDs remain private to the adapter. New and branched sessions
send their selected model before the first prompt; portable reasoning labels
are sent through OpenCode's variant field. The adapter exposes the configured
OpenCode catalog and default model to runtime preflight.
Its model-selection validator rejects missing or disabled reasoning variants.
Authentication and transport failures retain their original error meaning.

`startOpenCodeService` owns a private loopback service on an allocated port.
It preserves native configuration, bounds startup and shutdown, and closes
only the process group it creates. Its caller must close the returned service.
This helper writes no Seqlane state; OpenCode can write its own native state.

After a successful prompt, the adapter retains its terminal OpenCode message
ID as a private checkpoint. A Seqlane branch calls OpenCode's native
`session.fork` with that source session ID and message ID; it never summarizes
history or starts an empty replacement. OpenCode IDs remain inside this private
adapter and do not cross Seqlane authoring, Plan, event, or IPC boundaries.
