---
id: task.effect-v4-optimize-policy-clocks
title: Deterministic policy timing
status: planned
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-optimize-classifier-client
supersedes: []
---

# Deterministic policy timing

## Objective

Remove duplicated infrastructure through the pinned Effect v4 APIs. Preserve supported behavior and observability.

## Upstream requirements

The active execution and operations spec owns all contracts. Oclif and public/wire Zod stay unchanged.

## Documentation impact

Classification: implementation-only.

- PRD, RFC, ADR and SPEC: no change; existing ownership and behavior apply.
- TASK: create this bounded follow-up after the completed migration.
- Nearby docs: update only changed private service or process descriptions.

## Scope

Replace policy sleeps and redundant fake timing infrastructure with TestClock.layer. Consolidate repeated fixtures only when distinct behavior remains tested. Audit remaining nested roots and manual coordination across all packages. Record before/after production and test size.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: Production policy -> inherited Clock -> deterministic timeout/retry/queue tests.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

Runtime, adapter, CLI and Action timing tests; final distributions and measurements

## Verification

Keep OS/socket/process tests real. Run full gates, installed tarballs, compiled CLI, distributions, Actions and CI on the final exact head. Report remaining native API gaps and measured reductions without claiming API-count coverage.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

Pending.

## Delivery state

Planned on `feat/effect-v4-migration`; no default-branch delivery claim.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-classifier-client](./2026-10-22-effect-v4-optimize-classifier-client.md)
