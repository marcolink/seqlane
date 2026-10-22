---
id: task.effect-v4-optimize-process-services
title: Native process services
status: planned
owners:
  - core
created: 2026-10-22
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - task.effect-v4-optimize-transactional-admission
supersedes: []
---

# Native process services

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

Use ChildProcess/ChildProcessSpawner and scoped streams for routine process lifecycle where behavior remains compatible. Retain narrow native seams for IPC, process identity and detached Action residents. Remove duplicate routine mechanisms, not safety policies.

## Out of scope

Public API changes, weaker bounds, distributed execution, replay, new provider calls and unrelated dependency upgrades.

## Implementation plan

Tracer bullet: Adapter/Action process launch -> stream/readiness -> owned shutdown and identity confirmation.

First verify that path. Expand to the remaining callers only after its integration tests pass. Remove the replaced mechanism. Use a fresh implementation session, review each acceptance criterion, run full gates, then commit this task before its dependent task.

## Affected areas

libs/acp; libs/codex; libs/opencode; libs/action-service-lifecycle; libs/action-merge-conflict-resolution; actions/ripwire-server; apps/cli

## Verification

Real child tests must prove exit, descendants, output bounds, foreign-process survival and finite uncertain-cleanup failures. Run actual hosted Actions for changed bundles. Check Snyk and exact pins before dependency changes.

Run test mapping before tests. Run frozen install, docs validation, typecheck, tests, lint, build, formatting, Nx synchronization and diff checks.

## Completion criteria

The tracer and expanded callers pass. Replaced code is removed. Measured scope changes and retained native API gaps have concrete evidence. No behavior or documentation drift remains.

## Outcome

Pending.

## Delivery state

Planned on `feat/effect-v4-migration`; no default-branch delivery claim.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [task.effect-v4-optimize-transactional-admission](./2026-10-22-effect-v4-optimize-transactional-admission.md)
