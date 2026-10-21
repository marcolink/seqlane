---
id: task.migrate-all-packages-to-effect-v4
title: Migrate All Packages to Effect v4
status: in-progress
owners:
  - core
created: 2026-10-21
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Migrate All Packages to Effect v4

## Objective

Deliver the full migration across all 23 packages, including CLI, Actions, hosting, adapters, and observability.
Keep Oclif and public/wire Zod contracts.
Finish with one Effect runtime and no previous-engine evidence in tracked content or distributions.

## Upstream requirements

The linked active specification owns the target requirements.
The linked RFC owns architecture choices, package disposition, behavior changes, and removal scope.
This task does not redefine product requirements.

## Scope

All packages in the RFC inventory, plus root tooling, documentation, skills, generated outputs, and release verification.

## Out of scope

Git history rewrites, old-history import, durable action replay, distributed execution, a custom Studio, and replacement of Oclif or public/wire Zod.

## Implementation plan

### Tracer bullet: real CLI execution with observable process cleanup

S1 owns the acceptance path and evidence matrix in [Execute the tracer](./2026-10-21-effect-v4-effect-tracer.md#tracer-matrix). Refresh the inspected source snapshot and inventory at S0 before implementation. The tracer stays stack-only until feature parity permits command cutover; do not add a user-facing engine flag or implicit fallback. Temporary internal test composition must have a named removal point at S9.

## Slice checklist

Each slice task owns its implementation scope and evidence. Dependencies are explicit through task `upstream` metadata.

- [x] [S0 — Authority and baseline](./2026-10-21-effect-v4-authority-and-baseline.md)
- [x] [S1 — Execute the tracer](./2026-10-21-effect-v4-effect-tracer.md)
- [x] [S2 — Real dependency graphs and failures](./2026-10-21-effect-v4-dependency-graphs.md)
- [x] [S3 — Sessions and workspace admission with real callers](./2026-10-21-effect-v4-sessions-and-workspace-admission.md)
- [x] [S4 — Nested workflows, choices, repeats, and validation](./2026-10-21-effect-v4-nested-workflows-and-validation.md)
- [ ] [S5 — OpenCode and Codex with full observations](./2026-10-21-effect-v4-native-adapters-and-observations.md)
- [ ] [S6 — ACP without the old transport](./2026-10-21-effect-v4-acp-transport.md)
- [ ] [S7 — Classifier, mixed workflows, and deadlines](./2026-10-21-effect-v4-classifier-and-deadlines.md)
- [ ] [S8 — Telemetry sinks and event pressure](./2026-10-21-effect-v4-telemetry-and-event-pressure.md)
- [ ] [S9 — CLI and direct Action cutover](./2026-10-21-effect-v4-cli-and-action-cutover.md)
- [ ] [S10 — Hosted history, HTTP, MCP, and inspection](./2026-10-21-effect-v4-hosted-history-and-inspection.md)
- [ ] [S11 — Remaining Actions and distribution](./2026-10-21-effect-v4-remaining-actions-and-distribution.md)
- [ ] [S12 — Complete removal and release gate](./2026-10-21-effect-v4-complete-removal-and-release.md)

### Dependencies and recovery

Default order: `S0 -> S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> S7 -> S8 -> S9 -> S10 -> S11 -> S12`.
Create one reviewed commit per completed task on `feat/effect-v4-migration`. Include its evidence and deletion list.
Early runtime slices are stack-only until caller parity; do not claim independent release readiness.
After parity, CLI/Action and host work can form separate review units on the verified shared base.
No parallel implementation or delegation is required by this plan.

If evidence fails, repair that slice before expanding scope.
Rollback uses the preceding complete commit/release, not an embedded old engine.
Keep old user databases untouched and never replay uncertain agent/process writes.

## Affected areas

The RFC package table is the exhaustive package checklist.
The exact symbol/file inventory must be refreshed at S0 because the target branch can change before implementation.

## Verification

| Gate                 | Evidence                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Documentation        | `pnpm docs:index`, `pnpm docs:validate`, public documentation build, link and engine-removal audit                     |
| Test mapping         | `pnpm test:mapping` before each scoped test suite and before `pnpm test`                                               |
| Code quality         | `pnpm lint`, `pnpm typecheck`, formatting, and `git diff --check`                                                      |
| Behavioral parity    | Plan, sessions, workspace, adapters, classifier, output, protocol, and cancellation fixtures                           |
| Real integrations    | Compiled CLI, real process trees, local HTTP/MCP, SQL restart, and native harness smoke evidence                       |
| Event integrity      | Golden encoding/replay, malformed input, full JSON preservation, ordering, backpressure, and terminal settlement       |
| Resource ownership   | Startup failure, signals, lost supervisor, uncertain termination, bounded release, and foreign-resource survival       |
| Standalone isolation | No Seqlane listener, DB, recordings, summary, retained cache, or hidden exporter                                       |
| Package boundaries   | Generic runtime imports no concrete adapter; core/protocol expose no runtime service or engine state                   |
| Distribution         | `pnpm build`, frozen install, release dry runs, packed external consumer, and Action bundle execution                  |
| Dependency security  | Exact-version Snyk checks before additions, plus project dependency/license audit                                      |
| Performance          | Compare baseline startup, deterministic throughput, ready-node latency, event serialization, peak memory, and shutdown |
| Publication          | Required CI succeeds on the exact published head; record commit/PR reachability                                        |

Use Node 24 or newer, matching the repository engine requirement.
Keep versioned public/wire changes separate from implementation changes.
Report measured regressions and resolve unexplained differences before release; do not invent performance targets without a baseline.

## Completion criteria

All target-spec requirements and all package dispositions have evidence.
No old engine integration, dependency, name, document, skill, generated artifact, or runtime fallback remains in scope.
Oclif and public/wire Zod remain.
Canonical observations, terminal output, and hosted inspection have replacement evidence.
Every temporary bridge is removed, all required checks pass, and delivery is recorded against the target branch.

## Outcome

S0–S4 completed with full verification: authority, baseline, Effect process ownership, dependency graphs, sessions, workspace admission, nested workflows, choices, repeats, and validation through the CLI worker and direct facade. S5–S12 remain. Production Plan and hosted cutover are pending.

## Delivery state

In progress on one migration branch. S0–S4 have branch-local evidence in their task commits. The accepted architecture and active target spec record authority, not migration delivery.

## Traceability

- [spec.effect-v4-execution-and-operations: Target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [Migration proposal and package inventory](../rfcs/2026-10-21-effect-v4-migration.md)
- [Standalone CLI contract](../specs/2026-09-16-standalone-cli-runs.md)
- [Canonical observation target, currently draft](../specs/2026-09-19-otel-aligned-observation-contract.md)
- [Machine output](../specs/2026-09-15-run-machine-output.md)
- [Public distribution](../specs/2026-09-21-public-npm-distribution.md)
