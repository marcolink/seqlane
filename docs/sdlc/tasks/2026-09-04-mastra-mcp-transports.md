---
id: task.mastra-mcp-transports
title: Run Seqlane Workflows Through Mastra MCP Transports
status: planned
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Run Seqlane Workflows Through Mastra MCP Transports

## Objective

Make the registered Seqlane MCP server usable by local and network clients.

## Dependencies

- [task.mastra-operational-host](./2026-09-04-mastra-operational-host.md)
- [task.cli-run-status-and-cancel](./2026-09-04-cli-run-status-and-cancel.md)

## Delivery

- Stack order: 16
- Branch: `mastra-16-mcp-transports`
- Pull request base: `mastra-15-cli-run-control`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Upstream requirements

- `requirement-server-mcp`
- `requirement-cross-surface-run`
- `requirement-community-license`
- `requirement-public-boundary`

## Scope

- Expose `seqlane-workflows` through Mastra's Streamable HTTP server route.
- Add `seqlane mcp` for Mastra's stdio transport.
- Use the same workflow discovery and registration path for both transports.
- Map each discovered workflow to one validated MCP tool.
- Propagate Work, Run, and Invocation identities into storage and traces.
- Return stable Seqlane results and normalized errors from tool execution.
- Document client configuration for stdio and Streamable HTTP.
- Delete in-process-only MCP invocation helpers after tests and callers switch.

## Out of scope

- A custom Seqlane MCP protocol or transport.
- Legacy MCP SSE as a required transport.
- Remote authentication, hosted MCP, or Mastra Cloud.
- MCP resources and prompts that do not expose workflows.

## Implementation plan

1. Verify `MCPServer.startStdio()` against the pinned declarations.
2. Verify the server adapter's `mcp-http` route against the pinned declarations.
3. Connect both transports to the shared operational composition root.
4. Validate tool input and normalize tool results and failures.
5. Add real MCP client contract tests for both transports.
6. Remove direct handler tests that bypass transport behavior.

## Affected areas

- `apps/seqlane-cli`
- `libs/seqlane-runtime`
- runtime and MCP integration tests
- MCP client setup documentation

## Verification

- A client lists the same workflow tools over stdio and Streamable HTTP.
- A client executes a deterministic workflow through each transport.
- Invalid tool input fails without starting a run.
- Tool execution retains one Work and Run identity.
- Mastra storage and traces contain the MCP-started run.
- Deterministic MCP execution makes zero model calls.
- No Seqlane-owned generic MCP transport remains.

## Completion criteria

External MCP clients can list and run Seqlane workflows through Mastra-owned
stdio and Streamable HTTP transports.

## Outcome

Not started.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-server-mcp](./2026-09-03-mastra-server-mcp.md)
- [rfc.mastra-runtime-and-operational-foundation](../rfcs/2026-09-03-mastra-runtime-and-operational-foundation.md)
