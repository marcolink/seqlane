---
id: task.direct-run-cleanup
title: Simplify Direct Workflow Runs
status: in-progress
owners:
  - core
created: 2026-09-17
updated: 2026-10-22
upstream:
  - spec.effect-v4-execution-and-operations
  - spec.executor-neutral-workflow-authoring
supersedes: []
---

# Simplify Direct Workflow Runs

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Correct `seqlane run` so one explicit workflow entrypoint executes in an
isolated runner child without Seqlane operational-host or persistence overhead.

## Scope

- Require an explicit workflow file or package entrypoint.
- Remove catalog and descriptor resolution from `run` only.
- Route dry and executing runs through the existing runner IPC boundary.
- Keep direct runtime execution and the existing runtime-profile and adapter
  configuration contract inside the worker.
- Remove run-owned operational host, durable storage, history, recording, and
  GitHub summary behavior from `run`.
- Preserve worker supervision, canonical events, terminal outcomes,
  cancellation, exit statuses, Codex, ACP, and configured OpenCode support.
- Cancel and clean up worker-owned execution when the CLI supervisor IPC
  disconnects, then terminate the worker.
- Leave `list`, `plan`, `serve`, `status`, `cancel`, Studio, replay, and hosted
  behavior unchanged except for minimal shared-code corrections.

## Out of Scope

- Managed OpenCode startup or shutdown.
- New adapter, endpoint, credential, or lifecycle flags.
- Runtime-profile removal or Codex/ACP lifecycle redesign.
- Recording product, operational-host, hosted, or model-selection redesign.

## Verification

- Run `pnpm test:mapping` before focused tests.
- Run focused CLI, runner IPC, runtime-profile, and adapter tests.
- Run compiled CLI explicit-entrypoint tests, including malformed input,
  catalog-alias rejection, deterministic zero-model work, configured OpenCode,
  Codex, ACP, JSON output, and signals.
- Cover abrupt supervisor termination, including adapter-resource cleanup and
  runner-child shutdown.
- Run relevant typecheck, lint, formatting, build, documentation, and
  `git diff --check` gates.

## Delivery State

Implementation is in progress on a fresh branch based on local `main`. The
delivery claim requires a reachable commit or merged pull request on the target
branch; this task status is not delivery evidence.

## Traceability

- [spec.effect-v4-execution-and-operations](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [spec.executor-neutral-workflow-authoring](../specs/2026-09-02-executor-neutral-workflow-authoring.md)
