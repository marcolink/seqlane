---
id: task.operational-workflow-registration-boundary
title: Narrow the Operational Workflow Registration Boundary
status: planned
owners:
  - core
created: 2026-09-06
updated: 2026-09-06
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Narrow the Operational Workflow Registration Boundary

## Objective

Make the private operational-host registration boundary accept only validated
Mastra workflow values without exposing Mastra types through public Seqlane
contracts.

## Upstream requirements

- `requirement-public-boundary`
- `requirement-server-mcp`

## Scope

- Replace the operational registration `unknown` value and `as never` cast.
- Keep the boundary private to `@seqlane/runtime` integration modules.
- Validate malformed registration input before host composition.
- Add regression coverage for accepted and rejected registration values.

## Out of scope

- Changing the public workflow-authoring DSL or serialized Plan contracts.
- Adding a second workflow engine or a Seqlane-owned server abstraction.
- MCP transport delivery, operational data retention, or discovery budgets.

## Implementation plan

1. Define the narrow private registration input owned by the Mastra integration.
2. Make operational-host composition consume that input without an unchecked cast.
3. Add malformed-input and normal registration tests.
4. Verify generated public declarations contain no Mastra types.

## Affected areas

- `libs/seqlane-runtime` Mastra operational-host integration
- private runtime boundary tests

## Verification

- A valid compiled Mastra workflow registers successfully.
- An arbitrary value cannot pass the operational registration boundary.
- Public Seqlane declarations remain Mastra-free.

## Completion criteria

The operational host has one typed private workflow-registration boundary with
no unchecked `unknown`-to-Mastra cast.

## Outcome

Not started.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-operational-host](./2026-09-04-mastra-operational-host.md)
- [task.mastra-mcp-transports](./2026-09-04-mastra-mcp-transports.md)
