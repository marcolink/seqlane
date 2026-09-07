# @seqlane/acp

Private ACP adapter implementation for Seqlane runtime agent tasks.

The package owns ACP launch configuration validation, stream translation,
cancellation, non-interactive permission handling, and structured output
validation. It accepts a generic ACP command configuration and contains no
provider-specific defaults or session behavior. With the pinned `@mastra/acp`
0.4.0 API, one adapter serializes executions because its ACP connection has
one active prompt and one agent-level permission callback.
