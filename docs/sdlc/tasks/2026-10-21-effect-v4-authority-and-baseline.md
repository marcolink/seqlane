---
id: task.effect-v4-authority-and-baseline
title: Authority and baseline
status: completed
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - spec.effect-v4-execution-and-operations
supersedes: []
---

# Authority and baseline

## Objective

Establish the accepted Effect v4 target as the current runtime contract, preserve non-engine product behavior, and record the migration baseline before implementation.

## Upstream requirements

The active [Effect v4 execution and operations spec](../specs/2026-10-21-effect-v4-execution-and-operations.md) owns the target contract. The [coordination task](./2026-10-21-migrate-all-packages-to-effect-v4.md) owns the full migration checklist and cross-slice gates. This task records authority and baseline evidence; it does not redefine either.

## Scope

Reconcile the PRD, RFC, active specs, `AGENTS.md`, and runtime skill with the accepted target. Preserve authoring, session, choice, repeat, classifier, CLI, output, and protocol behavior by normative incorporation until S12 transfers the requirements to target-only owners. Record baseline verification and generate the exact package, file, dependency, and legacy-document inventory.

### Initial inventory and baseline

The [pre-migration inventory](./2026-10-21-effect-v4-inventory.json) records snapshot `51249b721a340959702e550fb84e7a3bd51ed59f`: 23 workspace packages, 255 engine-matched tracked paths, 166 canonical Markdown documents, package dependency ownership, and inbound legacy-document references. Counts are historical; regenerate the inventory before the final removal gate.

Baseline repair evidence: install, mapped tests, tests, typecheck, lint, build, formatting, Nx sync, and `git diff --check` pass after the documented test-fixture and project-reference corrections. Registry checks recorded `effect`, `@effect/platform-node`, and `@effect/platform-node-shared` 4.0.5; Snyk reported no direct vulnerabilities. No dependency changes are part of S0. The compiled deterministic CLI `--json` baseline passed three runs (wall time 2133.04, 2314.78, and 1544.91 ms; 511 stdout bytes; zero stderr bytes). These are baseline results, not migration delivery evidence. The finalized S0 gate passed frozen installation, SDLC validation, test mapping, typecheck, tests, lint, build, formatting, Nx sync, and whitespace checks.

## Out of scope

Executable runtime migration and dependency changes belong to later slices. This task does not alter product requirements.

## Implementation plan

- Align accepted RFC, active target spec, PRD, and still-active specs on authority and delivery state.
- Retain exact engine-independent contracts by explicit incorporation until canonical transfer at S12.
- Record current test mapping, build, typecheck, dependency, output-fixture, and performance baselines.
- Generate the package/file/dependency removal inventory and legacy-document reference map.

## Affected areas

SDLC PRD, RFC, specs, task documents and indexes, root `AGENTS.md`, and the runtime skill.

## Verification

`pnpm docs:index` and `pnpm docs:validate` pass. Baseline mapped tests, tests, typecheck, lint, build, formatting, Nx sync, and diff checks pass as recorded above. The complete package ownership map is linked above.

## Completion criteria

The accepted architecture and active target spec are clearly authoritative while runtime delivery remains explicitly incomplete. All retained product clauses have normative owners. The exact inventory and baseline evidence are recorded. Documentation index and validation checks pass.

## Outcome

Completed the authority transition, canonical task split, exact snapshot inventory, runtime guidance, baseline test typing repairs, and missing project reference. All S0 acceptance checks passed. No executable runtime migration or dependency change belongs to this task.

## Delivery state

Completed on `feat/effect-v4-migration` in this task commit. This is branch-local evidence. No default-branch or remote-CI delivery claim is made.

## Traceability

- [spec.effect-v4-execution-and-operations: target contract](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.migrate-all-packages-to-effect-v4: coordination checklist](./2026-10-21-migrate-all-packages-to-effect-v4.md)
