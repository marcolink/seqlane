---
id: task.deliver-standalone-cli-runs
title: Deliver Standalone CLI Runs
status: in-progress
owners:
  - core
created: 2026-09-16
updated: 2026-09-16
upstream:
  - spec.standalone-cli-runs
  - spec.run-machine-output
  - spec.run-terminal-rendering
supersedes: []
---

# Deliver Standalone CLI Runs

## Objective

Deliver the next CLI increment: execute one file or package workflow without an
app, catalog, Seqlane configuration, operational server, or Seqlane persistence.
Adapter selection alone must prepare an installed and authenticated adapter.

## Upstream requirements

Implement all requirements in
[spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md#requirements).
Preserve the terminal and final machine-output contracts. The spec owns
behavior. This task defines implementation and evidence.

## Scope

- Explicit file/package selection and project-aware TypeScript loading.
- Input validation, stdin, and independent execution workspace resolution.
- Direct Mastra execution with in-memory state and bounded cleanup.
- Managed adapter startup, native authentication and permission configuration.
- Workflow-owned model selection with explicit compatibility failures.
- Removal of run catalog, host, runtime-profile, recording, and summary writes.
- Installed CLI, examples, hook/caller migration, and regression coverage.

## Out of scope

- App registration, `serve` discovery, Studio, MCP, or hosted retention redesign.
- Permission policy, untrusted workflow isolation, or model fallback.
- Logging, persistence, run resumption, watch mode, and dependency installation.
- New terminal interaction or a different workflow engine.

## Delivery tasks

Execute these tasks in dependency order. Review, verify, and commit each task
before starting its successor. This document remains the parent deliverable.

1. [task.standalone-workflow-loading](./2026-09-16-standalone-workflow-loading.md)
2. [task.standalone-adapter-lifecycle](./2026-09-16-standalone-adapter-lifecycle.md)
3. [task.standalone-run-execution](./2026-09-16-standalone-run-execution.md)
4. [task.standalone-cli-cutover](./2026-09-16-standalone-cli-cutover.md)

## Implementation plan

1. Inspect the pinned Mastra and adapter APIs and `startWorkflowRun` in
   `libs/runtime/src/start-workflow-run.ts` as the existing direct-run seam.
   Prove an in-memory workflow run without a Seqlane listener. Keep engine types
   private. Do not replace Mastra scheduling or process primitives.
2. Implement explicit reference resolution from an external caller project.
   Add the supported TypeScript loader behavior and invalid-export diagnostics.
   Evaluate existing dependencies before selecting a new loader dependency.
3. Implement input and workspace preparation. Keep module resolution independent
   of `--workspace`. Cover stdin and imported-module diagnostic routing.
4. Add a private adapter lifecycle seam. Verify OpenCode startup without Seqlane
   configuration and preserve the same contract for supported adapter IDs.
   Cover ownership, readiness, authentication errors, concurrency, and cleanup.
5. Enforce workflow model declarations and adapter compatibility. Prove no
   substitution and distinguish model failures from connection/authentication.
6. Connect the selected workflow to direct Mastra execution and existing event
   consumers. Keep all canonical run state in memory.
7. Remove obsolete run flags and its host/catalog/recording/storage paths.
   Retain shared hosted functionality. Migrate internal callers and examples.
8. Run the verification matrix and reconcile canonical docs with delivery
   evidence. Record any unsupported adapter capability as a delivery blocker.

## Affected areas

- `apps/cli/src/commands/run.ts`, reference loading, input handling, and lifecycle.
- `apps/cli/src/run-operational-host.ts` and run-only host/client dependencies.
- `libs/runtime` workflow loading, compilation, direct execution, and disposal.
- `libs/adapter`, `libs/opencode`, `libs/acp`, and `libs/codex` integration seams.
- CLI entrypoint tests, runtime tests, and fixtures.
- Root/CLI/examples READMEs, hook callers, and canonical SDLC documents.

## Verification

Run `pnpm test:mapping` before tests. Run focused loader, CLI, runtime, and
adapter tests, followed by affected typechecks, lint, and compiled CLI tests.
Use the specification's verification matrix as the acceptance checklist.

Exercise the installed CLI from a temporary external project. Use file and
package entrypoints with normal imports. Exercise the real supported OpenCode
startup path when its executable and authentication are available. Record a
missing live prerequisite as pending evidence, not a passing check.

Use isolated filesystem and process fixtures. Prove no Seqlane persistence or
listener, bounded shutdown, and survival of foreign services.
Verify deterministic workflows make zero model calls and start no adapters.
Run hosted-command regressions to prove shared runtime behavior remains intact.

Check public declarations for Mastra leakage and reject `/ee/` imports. Run
`pnpm docs:index` and `pnpm docs:validate` after delivery reconciliation.

## Completion criteria

- Every standalone spec requirement has passing observable verification.
- File and package runs need only the selected adapter and its prerequisites.
- Workflow model choices and adapter permissions remain authoritative.
- Direct execution creates no Seqlane server or durable state.
- Terminal, JSON, cancellation, and hosted regressions pass.
- Obsolete run behavior and stale caller documentation are removed.
- Required checks, live evidence, and the reachable delivery commit or merged
  pull request are recorded before claiming target-branch delivery.

## Outcome

Not implemented. This task is the next agreed implementation deliverable.
The current change establishes its decision, specification, and acceptance
criteria only.

## Delivery state

Planned. No implementation or target-branch delivery is claimed by this task.

## Traceability

- [spec.standalone-cli-runs](../specs/2026-09-16-standalone-cli-runs.md)
- [spec.run-machine-output](../specs/2026-09-15-run-machine-output.md)
- [spec.run-terminal-rendering](../specs/2026-09-15-run-terminal-rendering.md)
- [adr.standalone-cli-runs](../adrs/2026-09-16-standalone-cli-runs.md)
