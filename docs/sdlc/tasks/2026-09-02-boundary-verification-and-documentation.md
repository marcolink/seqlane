---
id: task.boundary-verification-and-documentation
title: Verify Boundaries and Complete the Migration
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.consumer-agnostic-seqlane-execution-events
supersedes: []
---

# Verify Boundaries and Complete the Migration

> Migrated from implementation story `TS-016-05`.

## Summary

Prove the event contract is safe, stable, and correctly adopted everywhere.

## Use Case

**As a** Seqlane maintainer, **I want to** verify all event boundaries and
document the consumer model, **so that** future packages can add consumers
without reintroducing runtime, Studio, or executor coupling.

## Acceptance Criteria

**Scenario:** *Public boundaries remain executor-neutral*

- **Given:** The repository builds all affected packages
- **When:** dependency, export, and type checks run
- **Then:** canonical events contain no Mastra, OpenCode, executor, prompt,
  credential, or raw callback types, and all imports use package exports

**Scenario:** *End-to-end consumers agree*

- **Given:** A representative workflow uses normal tasks and repeats
- **When:** It runs through runner, CLI, output, Studio, and recording
- **Then:** all consumers observe the same ordered event stream and Studio
  renders the same final state as replay

**Scenario:** *Documentation describes the supported contract*

- **Given:** An engineer wants to add a new consumer
- **When:** They read the architecture and package documentation
- **Then:** ownership, redaction, ordering, lifecycle, replay, and deferred
  standards-adapter decisions are clear

## Technical Details

Add the required package, runtime, CLI, Studio, recording, replay, security,
and boundary tests from spec.consumer-agnostic-seqlane-execution-events. Remove stale primary `RunnerEvent` usage and
update package READMEs, architecture indexes, and examples. Keep W3C trace
context as optional metadata; document OpenTelemetry and CloudEvents as future
adapters only. Verify with `pnpm` Nx type checks, unit tests, integration
coverage, `git diff --check`, and a representative end-to-end run/replay.

Dependencies: task.canonical-execution-events-package through task.recording-and-replay. Likely files: affected package
READMEs, docs indexes, boundary tests, fixtures, and CI/test configuration.

## Out of Scope

- Implementing an OpenTelemetry exporter
- Implementing a CloudEvents transport
- Adding third-party consumer plugin discovery
- Changing workflow authoring or executor boundaries

## Source

- [adr.consumer-agnostic-seqlane-execution-events](../adrs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [spec.consumer-agnostic-seqlane-execution-events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
- [adr.executor-neutral-workflow-authoring](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)

## Traceability

- [spec.consumer-agnostic-seqlane-execution-events](../specs/2026-09-02-consumer-agnostic-seqlane-execution-events.md)
