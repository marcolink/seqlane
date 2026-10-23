# @seqlane/acp-adapter

Private ACP adapter implementation for Seqlane runtime agent tasks.

The package owns ACP launch configuration validation, stream translation,
cancellation, non-interactive permission handling, and structured output
validation. It accepts a generic ACP command configuration and contains no
provider-specific defaults. The pinned official `@agentclientprotocol/sdk`
2.0.0 stable v1 client runs over the agent's stdio connection. One adapter
serializes executions because the connection owns one active prompt and one
session lifecycle.

Effect owns process lifetime, cancellation, stream consumption, deadlines, and
cleanup. A schema guard validates native session notifications before the SDK
router can discard malformed updates. Accepted SDK updates feed Seqlane tool
activity and usage observations. Usage observations retain the complete ACP
notification, including `sessionId`, `update`, and optional `_meta`. Context
counts describe occupancy; cost is cumulative for the session. The SDK does not
provide per-call model usage or provider identity in these updates, so those
metrics remain unavailable.

When `model` is configured, the adapter selects that exact value from an
advertised model-category session config option. It fails before prompting if
the agent does not advertise the value. The adapter denies permission requests
and does not provide file or terminal client operations.
