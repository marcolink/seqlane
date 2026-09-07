---
id: task.protocol-agnostic-acp-adapter
title: Implement a Protocol-Agnostic ACP Adapter
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream:
  - spec.agent-adapter-boundary-and-capabilities
supersedes: []
---

# Implement a Protocol-Agnostic ACP Adapter

## Objective

Extract ACP execution into a private adapter that contains no OpenCode-specific
defaults, types, prompts, or session behavior.

## Dependencies

- [task.mastra-agent-acp](./2026-09-03-mastra-agent-acp.md)

## Delivery

- Follow-up order: 1
- Branch: `agent-adapters-01-generic-acp`
- Pull request base: `mastra-16-agent-adapter-boundary`
- Implementation agent: fresh high-reasoning subagent
- Delivery unit: one task branch and one pull request

## Upstream requirements

- `requirement-agent-adapter-boundary`
- `requirement-generic-acp-adapter`
- `requirement-autonomous-interactions`
- `requirement-private-observability`

## Scope

- Add a private ACP adapter package or cohesive private module.
- Move ACP stream, cancellation, permission, activity, and output mapping into it.
- Accept validated ACP launch or connection configuration.
- Remove the built-in `opencode acp` command and OpenCode model formatting.
- Use Seqlane-owned adapter requests, results, diagnostics, and errors.
- Add focused unit tests for ACP translation and malformed stream data.

## Out of scope

- OpenCode SDK execution or session lifecycle.
- Runtime adapter selection.
- Checkpoint emulation or transcript copying.
- Final end-to-end migration coverage.

## Implementation plan

1. Define the minimum private ACP boundary from the active specification.
2. Extract ACP translation from `@seqlane/opencode`.
3. Inject the ACP implementation configuration without vendor defaults.
4. Map cancellation and unresolved interactions to shared failures.
5. Add focused contract tests around the ACP library boundary.

## Affected areas

- a new private ACP package or runtime adapter module
- `libs/seqlane-opencode`
- private runtime adapter contracts
- package manifests and Nx configuration

## Verification

- Search the ACP adapter for OpenCode imports, names, commands, and model formats.
- Prove stream output, cancellation, permission rejection, and activity mapping.
- Prove malformed ACP data fails through a typed private boundary.
- Run package tests, type checks, lint, build, and boundary checks.

## Completion criteria

- The ACP adapter accepts any supported ACP implementation configuration.
- The adapter contains no OpenCode dependency or built-in OpenCode behavior.
- OpenCode production callers no longer import the ACP implementation.
- Focused tests prove all translated ACP behavior.

## Outcome

Completed. Added the private `@seqlane/agent-adapter` contract with required
execution, normalized activity and diagnostic callbacks, declared capabilities,
and optional session operations. Added the private `@seqlane/acp` implementation
with validated generic launch configuration, Seqlane-owned errors, ACP stream
activity mapping, cancellation propagation, non-interactive permission
rejection, structured-output validation, and malformed-input tests. Removed ACP
ownership and exports from `@seqlane/opencode`; the runtime profile now composes
the generic adapter without exposing ACP or vendor types through public
contracts. Delivered in [PR #32](https://github.com/marcolink/seqlane/pull/32).

## Traceability

- [spec.agent-adapter-boundary-and-capabilities](../specs/2026-09-04-agent-adapter-boundary-and-capabilities.md)
- [task.mastra-agent-acp](./2026-09-03-mastra-agent-acp.md)
