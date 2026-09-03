---
id: task.mastra-community-studio
title: Replace the Dedicated Studio With Mastra Community Studio
status: planned
owners:
  - core
created: 2026-09-03
updated: 2026-09-03
upstream:
  - spec.mastra-runtime-and-operational-integration
supersedes: []
---

# Replace the Dedicated Studio With Mastra Community Studio

## Objective

Deliver one independently reviewable migration slice that satisfies its part of
the Mastra runtime integration contract.

## Dependencies

- [task.mastra-server-mcp](./2026-09-03-mastra-server-mcp.md)

## Delivery

- Stack order: 11
- Branch: `mastra-11-community-studio`
- Pull request base: `mastra-10-server-mcp`
- Implementation agent: a fresh `gpt-5.6-luna` subagent with `high` reasoning
- Delivery unit: exactly one task branch and one pull request

## Scope

- Implement `seqlane studio` as a Community Studio launcher/connector.
- Expose useful Seqlane metadata through supported Mastra points.
- Delete the dedicated Studio app, service, assets, replay code, and Nx projects.

## Out of scope

- Forking, rebranding, or embedding Studio.
- Enterprise or hosted Studio features.

## Implementation plan

1. Verify the upstream Community Studio workflow.
2. Switch the CLI command and documentation.
3. Remove dedicated Studio projects and dependencies.

## Affected areas

- `apps/seqlane-studio/`
- `libs/seqlane-studio/`
- CLI studio commands
- Nx configuration

## Verification

- The command launches/connects successfully.
- Run metadata is inspectable.
- Removed Studio projects are absent from Nx.

## Acceptance criteria

- **Given:** all dependency tasks are complete and the task branch matches the
  `Delivery` section
- **When:** the scoped implementation and required verification finish
- **Then:** the completion criteria are true, no out-of-scope change is present,
  and the branch is ready as one stacked pull request

## Completion criteria

The upstream Community Studio is the only supported operational UI.

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-server-mcp](./2026-09-03-mastra-server-mcp.md)
