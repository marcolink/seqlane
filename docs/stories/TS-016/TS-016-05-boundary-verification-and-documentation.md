# TS-016-05 — Verify Boundaries and Complete the Migration

**Status:** completed

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
and boundary tests from TS-016. Remove stale primary `RunnerEvent` usage and
update package READMEs, architecture indexes, and examples. Keep W3C trace
context as optional metadata; document OpenTelemetry and CloudEvents as future
adapters only. Verify with `pnpm` Nx type checks, unit tests, integration
coverage, `git diff --check`, and a representative end-to-end run/replay.

Dependencies: TS-016-00 through TS-016-04. Likely files: affected package
READMEs, docs indexes, boundary tests, fixtures, and CI/test configuration.

## Out of Scope

- Implementing an OpenTelemetry exporter
- Implementing a CloudEvents transport
- Adding third-party consumer plugin discovery
- Changing workflow authoring or executor boundaries

## Source

- [ADR-016](../../ADR-016-consumer-agnostic-seqlane-execution-events.md)
- [TS-016](../../TS-016-consumer-agnostic-seqlane-execution-events.md)
- [ADR-008](../../ADR-008-executor-neutral-workflow-authoring.md)
