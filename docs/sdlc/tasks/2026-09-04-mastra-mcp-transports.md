---
id: task.mastra-mcp-transports
title: Run Seqlane Workflows Through Mastra MCP Transports
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-10
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Run Seqlane Workflows Through Mastra MCP Transports

## Objective

Make the registered Seqlane MCP server usable by local clients through
loopback-only Streamable HTTP.

## Dependencies

- [task.mastra-operational-host](./2026-09-04-mastra-operational-host.md)
- [task.cli-run-status-and-cancel](./2026-09-04-cli-run-status-and-cancel.md)

## Delivery

- Stack order: 18
- Branch: `mastra-18-mcp-transports`
- Pull request base: `mastra-17-cli-run-control`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-server-mcp`
- `requirement-local-operational-access`
- `requirement-cross-surface-run`
- `requirement-community-license`
- `requirement-public-boundary`

## Scope

- Expose `seqlane-workflows` through Mastra's loopback-only Streamable HTTP route.
- Use the shared workflow discovery and registration path for Streamable HTTP.
- Map each discovered workflow to one validated MCP tool.
- Propagate Work, Run, and Invocation identities into storage and traces.
- Return stable Seqlane results and normalized errors from tool execution.
- Document local client configuration for Streamable HTTP.
- Delete in-process-only MCP invocation helpers after tests and callers switch.

## Out of scope

- A custom Seqlane MCP protocol or transport.
- Legacy MCP SSE as a required transport.
- Mastra stdio transport and a `seqlane mcp` command; track as a separate
  follow-up.
- Remote authentication, hosted MCP, or Mastra Cloud.
- MCP resources and prompts that do not expose workflows.

## Implementation plan

1. Verify the server adapter's `mcp-http` route against the pinned declarations.
2. Connect Streamable HTTP to the shared operational composition root.
3. Validate tool input and normalize tool results and failures.
4. Add real Streamable HTTP client contract tests.
5. Remove direct handler tests that bypass transport behavior.

## Affected areas

- `apps/seqlane-cli`
- `libs/seqlane-runtime`
- runtime and MCP integration tests
- MCP client setup documentation

## Verification

- A client lists the workflow tools over Streamable HTTP.
- A client executes a deterministic workflow through Streamable HTTP.
- Invalid tool input fails without starting a run.
- Tool execution retains one Work and Run identity.
- Mastra storage and traces contain the MCP-started run.
- Deterministic MCP execution makes zero model calls.
- No Seqlane-owned generic MCP transport remains.

## Completion criteria

External MCP clients can list and run Seqlane workflows through the
Mastra-owned loopback Streamable HTTP transport. Stdio transport is explicitly
outside this task's completed scope and requires a separate follow-up.

## Outcome

Completed within the narrowed scope. The loopback Streamable HTTP transport is implemented at
`/api/mcp/seqlane-workflows/mcp` on the operational host. It uses the shared
operational workflow registration, exposes discovered workflows as MCP tools,
and is covered by real MCP initialization, tool-discovery, and tool-call tests.
Tool calls use an `input` envelope and default their optional runtime profile
to server-owned `opencode` configuration; callers cannot provide adapter
configuration.

The `seqlane mcp` stdio transport is not implemented and is intentionally
tracked as a separate follow-up, outside this task's scope.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-server-mcp](./2026-09-03-mastra-server-mcp.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
