---
id: prd.seqlane-runtime
title: Seqlane Runtime Product Requirements
status: accepted
owners:
  - core
created: 2026-10-21
updated: 2026-10-21
upstream:
  - brd.seqlane
supersedes:
  - prd.seqlane-on-mastra
---

# Seqlane Runtime Product Requirements

## Summary

Seqlane provides a typed, reusable software-engineering workflow API and a focused CLI. Runtime technology is an internal implementation choice; authors use Seqlane contracts and behavior.

## Context

The product owns workflow authoring, task semantics, session and workspace policy, executor contracts, Work identity and provenance, and terminal experience. Execution, process ownership, cancellation, and operational telemetry support those outcomes. Oclif remains the CLI framework. Zod remains the source of truth for public and wire contracts.

## Goals

- Preserve typed workflows, task inputs and outputs, validation, dependencies, and composition.
- Preserve deterministic shell tasks with zero model calls.
- Preserve isolated, shared, checkpoint, and fork session semantics and workspace coordination.
- Preserve executor independence, Work identity, provenance, cancellation, and normalized outcomes.
- Preserve terminal, machine-readable, hosted inspection, and observation behavior through migration.
- Keep runtime-engine types out of public authoring and serialized contracts.

## Non-goals

- Changing workflow authoring semantics as a side effect of a runtime migration.
- Replacing Oclif or public and wire Zod validation.
- Durable replay of external coding actions, distributed execution, or a replacement Studio product.

## Users and use cases

Workflow authors define typed workflows without depending on runtime implementation types. Operators run workflows locally or in CI, observe results, and inspect hosted runs where configured. Maintainers evolve runtime execution while preserving product contracts.

## Product requirements

- `workflow()` remains the unit of discovery, reuse, composition, and execution.
- Tasks preserve declared input/output validation, dependency behavior, and task identity.
- `shell()` runs deterministic work without model or agent acquisition.
- Session and workspace policies remain explicit, coordinated, and cancellation-aware.
- Executor-specific APIs and connection details remain behind private adapter boundaries.
- Run outcomes, progress, observations, terminal output, and hosted inspection retain their documented Seqlane semantics.
- Standalone CLI runs retain their documented isolation and retention behavior.

## Constraints

The migration may change private implementation and dependencies. Any observable behavior change requires explicit documentation and evidence. Public and wire schemas remain Zod-owned; CLI commands and conventions remain Oclif-owned.

## Acceptance criteria

The active implementation spec and migration tasks define verifiable parity and removal evidence. This PRD does not claim runtime migration delivery.

## Traceability

- [brd.seqlane: Seqlane](../brd/2026-09-02-seqlane.md)
- [Full Effect v4 migration RFC](../rfcs/2026-10-21-effect-v4-migration.md)
- [Effect v4 execution and operations spec](../specs/2026-10-21-effect-v4-execution-and-operations.md)
- [Former product requirements, retained as history](./2026-09-03-seqlane-on-mastra.md)
