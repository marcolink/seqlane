# @seqlane/opencode

Private adapter for the initial Seqlane agent runtime. Workflow authors use
`@seqlane/core`; adapter SDK, session, and endpoint details stay
private.

The adapter creates runtime sessions using the selected runtime's existing
configuration. It does not receive, derive, merge, or apply Seqlane per-task
permission rules. Runtime configuration is authoritative for tools,
filesystem, shell, network, MCP, skills, and approvals.

The adapter submits structured-output prompts, observes activity, handles
cancellation, and converts unsupported interactive requests into the generic
non-interactive failure path. It never approves an interaction. Workspace
`shared` and `exclusive` policy is consumed by the Seqlane scheduler, not by
OpenCode permission configuration.

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
