---
id: task.adapter-cli-flags
title: Replace Direct-Run Runtime Flags with Adapter Flags
status: completed
owners:
  - core
created: 2026-09-19
updated: 2026-09-21
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
- OpenCode managed and external mode configuration.
- Direct-run flag, adapter, and lifecycle tests.

## Out of scope

- Standalone CLI cutover, workflow loading, runtime-engine, host, persistence,
  output, or runner IPC redesign.
- Hosted command configuration and ACP direct-run selection.

## Implementation plan

1. Add canonical CLI adapter-input validation and native Oclif constraints.
2. Replace direct-run environment loading with private child bootstrap.
3. Keep managed service ownership. Add external endpoint selection without
   service ownership.
4. Update direct-run documentation and focused tests.

## Verification

Run `pnpm test:mapping`, focused CLI and OpenCode tests, build checks,
`pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.

## Outcome

Implemented managed and external OpenCode modes. Native Oclif constraints
require `--adapter opencode` for OpenCode flags. Both modes use one runtime
factory. External mode never owns the service. Public documentation is current.

Local passes: frozen install, typecheck, mapping, focused runtime tests (10/10),
compiled CLI tests (26/26), build, format, documentation index/validation/tests,
and diff checks. Lint passed with warnings only. A process-lifecycle test passed
outside the sandbox.

Full `pnpm test` still fails in unchanged runtime non-cooperative MCP deadline
and CLI operational-client timeout tests. `nx sync:check` still reports the
unchanged `libs/opencode` missing `libs/protocol` reference.

## Delivery state

Completed locally. No target-branch reachability is claimed.

## Traceability

- [spec.adapter-cli-flags](../specs/2026-09-19-adapter-cli-flags.md)
- [Cancelled standalone CLI cutover](./2026-09-16-standalone-cli-cutover.md)
