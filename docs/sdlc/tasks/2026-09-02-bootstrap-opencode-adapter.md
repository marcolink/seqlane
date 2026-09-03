---
id: task.bootstrap-opencode-adapter
title: Bootstrap the OpenCode adapter boundary
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.opencode-executor-integration
supersedes: []
---

# Bootstrap the OpenCode adapter boundary

> Migrated from implementation story `TS-004-00`.

## Use Case

**As a** Seqlane maintainer, **I want to** create a private OpenCode adapter package with a proven SDK/server contract, **so that** later stories use one supported integration boundary.

## Scope

- Create `libs/seqlane-opencode` with intentional root exports, Nx targets, and declared workspace dependencies.
- Add the selected public `@opencode-ai/sdk` dependency and synchronize `pnpm-lock.yaml`.
- Add a local fake OpenCode HTTP server for adapter contract tests.
- Prove public SDK/server support for session creation, schema-backed structured task requests, final structured results, and session abort.
- Record the tested SDK version and compatible server contract in the package documentation.

## Out of Scope

- Public OpenCode task authoring.
- Runner integration or task execution.
- OpenCode process startup, shutdown, or CLI fallback.
- Prompt-only JSON parsing as a substitute for structured output.

## Implementation Notes

Use public package exports only. The contract test must fail when the selected SDK/server API has no structured-output schema field. Do not add a dependency or an adapter that relies on a private generated client path.

## Acceptance Criteria

**Scenario:** *The adapter uses a supported public contract*
- **Given:** The selected SDK version and a fake server that implements the documented OpenCode contract
- **When:** The package contract suite runs
- **Then:** It proves create-session, structured-request, final-structured-result, and abort operations through public SDK exports

**Scenario:** *Unsupported structured output blocks delivery*
- **Given:** An SDK/server combination without a schema-backed structured-output operation
- **When:** The compatibility suite runs
- **Then:** The suite fails before any task execution and does not accept prompt text that asks for JSON

**Scenario:** *Package boundaries stay private*
- **Given:** The workspace packages are built and inspected
- **When:** OpenCode SDK imports are searched
- **Then:** Only `@seqlane/opencode` imports SDK code or types, and no package starts or stops OpenCode

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.opencode-executor-integration — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../adrs/2026-09-02-opencode-executor-integration.md)
- [spec.opencode-executor-integration — OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
- [MVP — External OpenCode Only](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.opencode-executor-integration](../specs/2026-09-02-opencode-executor-integration.md)
