---
id: task.integrate-codex-runtime-adapter
title: Integrate the Codex Runtime Adapter
status: planned
owners:
  - core
created: 2026-09-12
updated: 2026-09-12
upstream:
  - spec.codex-app-server-adapter
supersedes: []
---

# Integrate the Codex Runtime Adapter

## Objective

Select the Codex adapter through private runtime configuration and prove end-to-end workflow behavior.

## Dependencies

- [task.implement-codex-app-server-adapter](./2026-09-12-implement-codex-app-server-adapter.md)

## Upstream requirements

- [requirement-codex-private-configuration](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-private-configuration)
- [requirement-codex-owned-lifecycle](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-owned-lifecycle)
- [requirement-codex-model-selection](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-model-selection)
- [requirement-codex-autonomous-policy](../specs/2026-09-12-codex-app-server-adapter.md#requirement-codex-autonomous-policy)

## Scope

- Extend the private runtime adapter schema with an explicit `codex` identity.
- Validate an absolute executable path and optional `networkAccess` boolean.
- Register the Codex factory and resolve capabilities before session admission.
- Bind the runtime workspace and model selection to each Codex thread or turn.
- Own each run's process cleanup in direct runs and persistent Seqlane hosts.
- Add end-to-end tests for isolated tasks, reuse, branches, failure, and cancellation.
- Update runtime documentation with the private configuration and supported scope.

## Out of scope

- Adapter selection in workflow source, Plans, or public CLI flags.
- Cross-run Codex thread reuse and external app-server connections.
- Changes to ACP or OpenCode behavior.
- A new Mastra runtime, scheduler, or canonical run store.

## Implementation plan

1. Extend the canonical configuration schema and adapter registry.
2. Connect managed process ownership to direct and persistent host lifecycles.
3. Map model discovery and capability preflight into existing runtime admission.
4. Add workflow tests through the real runtime boundary with a controlled app-server.
5. Update nearby configuration and operator documentation.

## Affected areas

- `libs/runtime/src/runner/profile/runtime-adapter.ts`
- direct-run and persistent-host composition roots
- runtime tests and documentation

## Verification

- Prove valid Codex configuration selects only Codex.
- Prove invalid configuration and unsupported capabilities fail before agent work.
- Prove two runs never share a Codex process or thread under one persistent host.
- Prove cancellation and interaction failure retain existing Seqlane outcomes.
- Check public declarations, Plans, events, and IPC for Codex and Mastra leaks.
- Run test mapping, focused runtime tests, typecheck, lint, build, format, and documentation checks.

## Completion criteria

- A configured workflow executes through Codex with unchanged public authoring and result contracts.
- Direct and persistent hosts own and clean up the app-server process correctly.
- ACP and OpenCode regression tests pass.
- No cross-run thread reuse or cross-adapter fallback occurs.

## Outcome

Planned. No runtime integration is recorded.

## Delivery state

No implementation or reachable delivery commit is recorded.

## Traceability

- [spec.codex-app-server-adapter](../specs/2026-09-12-codex-app-server-adapter.md)
- [task.implement-codex-app-server-adapter](./2026-09-12-implement-codex-app-server-adapter.md)
