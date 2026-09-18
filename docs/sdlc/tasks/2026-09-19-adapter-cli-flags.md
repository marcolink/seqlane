---
id: task.adapter-cli-flags
title: Replace Direct-Run Runtime Flags with Adapter Flags
status: in-progress
owners:
  - core
created: 2026-09-19
updated: 2026-09-19
upstream:
  - spec.adapter-cli-flags
supersedes: []
---

# Replace Direct-Run Runtime Flags with Adapter Flags

## Objective

Replace direct-run runtime selection and required adapter environment
configuration with validated adapter flags. Keep this work independent from
the cancelled standalone CLI cutover.

## Scope

- `run` adapter flags, validation, child bootstrap, and examples.
- OpenCode owned-service host and port configuration.
- Direct-run flag, adapter, and lifecycle tests.

## Out of scope

- Standalone CLI cutover, workflow loading, runtime-engine, host, persistence,
  output, or runner IPC redesign.
- Hosted command configuration and ACP direct-run selection.

## Implementation plan

1. Add canonical CLI adapter-input validation and Oclif constraints.
2. Replace direct-run environment loading with private child bootstrap.
3. Apply OpenCode bind settings to its owned service and verify readiness.
4. Update direct-run documentation and focused tests.

## Verification

Run `pnpm test:mapping`, focused CLI and OpenCode tests, build checks,
`pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.

## Delivery state

In progress. No target-branch delivery is claimed.

## Traceability

- [spec.adapter-cli-flags](../specs/2026-09-19-adapter-cli-flags.md)
- [Cancelled standalone CLI cutover](./2026-09-16-standalone-cli-cutover.md)
