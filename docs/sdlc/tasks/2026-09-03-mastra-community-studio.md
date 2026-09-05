---
id: task.mastra-community-studio
title: Replace the Dedicated Studio With Mastra Community Studio
status: completed
owners:
  - core
created: 2026-09-03
updated: 2026-09-05
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
- Pull request base: `mastra`
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

## Outcome

`seqlane studio` now launches the pinned Mastra Community Studio CLI and
connects it to the configured Seqlane/Mastra server endpoint. The dedicated
Seqlane Studio application, runtime service, replay publisher, assets, tests,
and Nx projects were removed. Run and replay no longer expose the superseded
local Studio forwarding flags. TypeScript references, workspace dependencies,
test aliases, and documentation for the removed projects were also removed.

The launcher remains a thin loopback-oriented connector. It does not fork,
rebrand, embed, or add hosted or Enterprise Studio features.

The launcher propagates non-zero Community Studio child exits, forwards
SIGINT/SIGTERM to the child, removes signal handlers after shutdown, and
reports the local HTTP UI address independently from the remote server
protocol.

## Deferred gaps and follow-up

This task does not complete the final agent-adapter architecture. The current
runtime intentionally keeps configured OpenCode execution on the native SDK
adapter because that adapter owns endpoint, workspace, checkpoint, and fork
semantics. The transitional Mastra ACP bridge is not selected by the current
production runtime path and must not be treated as the final OpenCode adapter.

The bridge still has an isolation gap: its ACP agent and permission state are
shared across executor invocations. The follow-up adapter work must replace
this bridge with separate generic ACP and OpenCode SDK adapters, select one
adapter explicitly, and isolate agent and session state before this gap is
closed. The planned work is tracked in [PR #32](https://github.com/marcolink/seqlane/pull/32),
[PR #37](https://github.com/marcolink/seqlane/pull/37),
[PR #40](https://github.com/marcolink/seqlane/pull/40), and
[PR #42](https://github.com/marcolink/seqlane/pull/42).

This follow-up is outside the Community Studio scope. Until it lands, the
production runtime must continue to use the native OpenCode SDK adapter and
the interim ACP bridge must remain unselected in production.

## Pull request

- [PR #25](https://github.com/marcolink/seqlane/pull/25)

## Traceability

- [spec.mastra-runtime-and-operational-integration](../specs/2026-09-03-mastra-runtime-and-operational-integration.md)
- [task.mastra-server-mcp](./2026-09-03-mastra-server-mcp.md)
