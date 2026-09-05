---
id: task.mastra-server-mcp
title: Expose Workflows Through Mastra Server and MCP
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-04
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Expose Workflows Through Mastra Server and MCP

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-storage-tracing](./2026-09-03-mastra-storage-tracing.md)

## Delivery

- Stack order: 10
- Branch: `mastra-10-server-mcp`
- Pull request base: `mastra-09-storage-tracing`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Register Seqlane workflows through Mastra server facilities.
- Expose domain operations through Mastra MCP facilities.
- Remove superseded generic Seqlane transports after callers switch.

## Out of scope

- Studio migration.
- New remote or hosted deployment requirements.

## Implementation plan

1. Verify the pinned Community server/MCP APIs.
2. Implement thin registration and translation.
3. Switch tests/callers and delete obsolete transports.

## Affected areas

- server and MCP modules
- runtime registration
- CLI integration

## Verification

- Registered workflows are discoverable and invocable.
- Malformed external input is schema-validated.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

Server and MCP behavior use Mastra infrastructure with only Seqlane-specific adapters.

## Outcome

Mastra's Community server route handlers now discover the registered Seqlane
workflows. A Community `MCPServer` is registered with Mastra and exposes each
workflow as a validated `run_<workflowKey>` tool. The private runtime adapter
keeps Mastra types behind the integration boundary, and focused tests cover
workflow discovery, MCP invocation, and malformed tool input. Workflow
descriptions are supplied for the MCP contract by the compiler and fixtures;
every registered workflow must provide a non-empty description, and the runtime
rejects registrations that do not meet this requirement.

The old generic server and MCP transport surface was not present on this
branch, so no additional transport deletion was required.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-storage-tracing](./2026-09-03-mastra-storage-tracing.md)
