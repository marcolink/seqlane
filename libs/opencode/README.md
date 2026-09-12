# @seqlane/opencode-adapter

Private SDK adapter for the Seqlane agent runtime. Workflow authors use
`@seqlane/core`; OpenCode SDK, session, and endpoint details stay private.

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

After a successful prompt, the adapter retains its terminal OpenCode message
ID as a private checkpoint. A Seqlane branch calls OpenCode's native
`session.fork` with that source session ID and message ID; it never summarizes
history or starts an empty replacement. OpenCode IDs remain inside this private
adapter and do not cross Seqlane authoring, Plan, event, or IPC boundaries.
