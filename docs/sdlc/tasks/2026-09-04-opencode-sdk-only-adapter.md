---
id: task.opencode-sdk-only-adapter
title: Restore the OpenCode SDK-Only Adapter
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - spec.agent-adapter-boundary-and-capabilities
supersedes: []
---

# Restore the OpenCode SDK-Only Adapter

## Objective

Make `@seqlane/opencode` one cohesive adapter that executes all OpenCode work
through the supported OpenCode SDK.

## Dependencies

- [task.protocol-agnostic-acp-adapter](./2026-09-04-protocol-agnostic-acp-adapter.md)

## Delivery

- Follow-up order: 2
- Branch: `agent-adapters-02-opencode-sdk`
- Pull request base: `agent-adapters-01-generic-acp`
- Implementation agent: fresh high-reasoning subagent
- Delivery unit: one task branch and one pull request

## Upstream requirements

- `requirement-agent-adapter-boundary`
- `requirement-opencode-sdk-only`
- `requirement-no-cross-adapter-fallback`
- `requirement-private-observability`

## Scope

- Route OpenCode task execution through the configured SDK client and endpoint.
- Keep OpenCode prompts, structured output, models, sessions, and UI in this adapter.
- Remove Mastra ACP dependencies and exports from `@seqlane/opencode`.
- Remove duplicate executor paths inside the OpenCode package.
- Preserve the repository harness and workspace binding.
- Keep SDK values and raw events inside the package.

## Out of scope

- Generic ACP execution.
- Public workflow or Plan changes.
- Runtime selection configuration.
- Cross-adapter session migration.

## Implementation plan

1. Select the SDK executor as the only OpenCode execution path.
2. Reconnect execution to the configured endpoint and workspace.
3. Consolidate OpenCode session and executor ownership.
4. Remove ACP imports, exports, diagnostics, and dependencies.
5. Update focused SDK contract tests and package documentation.

## Affected areas

- `libs/seqlane-opencode`
- OpenCode package manifest and lockfile entries
- private runtime imports
- OpenCode adapter documentation

## Verification

- Prove that task requests reach the configured fake OpenCode server.
- Prove that the configured workspace reaches the SDK request.
- Search `@seqlane/opencode` for ACP and Mastra production imports.
- Prove structured output, cancellation, activity, and interaction failures.
- Run package tests, type checks, lint, build, and boundary checks.

## Completion criteria

- `@seqlane/opencode` uses the SDK for every production OpenCode operation.
- The package exports one OpenCode adapter execution path.
- No ACP or Mastra dependency remains in the OpenCode package.
- The configured endpoint and workspace control the executed session.

## Outcome

Completed. Added the private SDK-backed `AgentAdapter` implementation for
`@seqlane/opencode`, moved OpenCode execution behind that boundary, preserved
structured output, model selection, activity, cancellation, interaction
failures, workspace, endpoint, checkpoint, fork, and session UI behavior, and
removed the runtime's ACP execution path and the superseded executor module.
Focused adapter and runtime tests, package builds, test mapping, and SDLC
validation pass.
Delivered in [PR #37](https://github.com/marcolink/seqlane/pull/37).

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [task.protocol-agnostic-acp-adapter](./2026-09-04-protocol-agnostic-acp-adapter.md)
