# zvec-grep server action

Starts the zvec-grep MCP server through `pnpm dlx`, waits for
`server status --check-ready`, and stops the process group in the action post
handler.

Readiness reads the configured listen address from the same instance home as
the started server, including custom loopback ports.

The action records the process identity in GitHub Actions state and verifies it
before cleanup. If state persistence fails, it cleans up the process group
immediately.

The indexing command remains in the caller because its file allowlist and
exclusions are workflow-specific policy.
