# @seqlane/acp

Private ACP adapter implementation for Seqlane runtime agent tasks.

The package owns ACP launch configuration validation, stream translation,
cancellation, non-interactive permission handling, and structured output
validation. It accepts a generic ACP command configuration and contains no
provider-specific defaults or session behavior. With the pinned `@mastra/acp`
0.4.0 API, one adapter serializes executions because its ACP connection has
one active prompt and one agent-level permission callback.

For each admitted invocation, the adapter projects ACP v1 tool observations
into native Mastra `AGENT_RUN` and `TOOL_CALL` spans. Queue wait stays outside
the agent span. One Zod parser and one adapter-local reducer fan validated tool
lifecycle transitions out to the existing activity callback and native spans.
Aggregate metrics remain a separate output. The adapter emits no model span or
model usage because this ACP v1 stream does not expose the underlying model or
observed token usage.
