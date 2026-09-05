# zvec-grep server action

Starts the zvec-grep MCP server through `pnpm dlx`, waits for
`server status --check-ready`, and stops the process group in the action post
handler.

The indexing command remains in the caller because its file allowlist and
exclusions are workflow-specific policy.
