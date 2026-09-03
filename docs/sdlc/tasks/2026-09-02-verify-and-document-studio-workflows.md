---
id: task.verify-and-document-studio-workflows
title: Verify and Document Studio Workflows
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.studio-vite-development-and-isolated-replay
supersedes: []
---

# Verify and Document Studio Workflows

> Migrated from implementation story `TS-017-04`.

## Summary

Prove that live Studio, HMR, production assets, and replay keep their boundaries.

## Use Case

**As a** Seqlane maintainer, **I want to** verify and document Studio
development workflows, **so that** future changes do not mix replay, live
ingestion, or execution behavior.

## Acceptance Criteria

**Scenario:** *The affected package checks pass*

- **Given:** The Studio application contains the Vite and replay changes
- **When:** Mapping, typecheck, unit test, and production build checks run
- **Then:** The checks pass with tests mapped to implementation files

**Scenario:** *Replay matches live projection behavior*

- **Given:** A complete recording was also consumed by the live projection
- **When:** Studio replays the recording to completion
- **Then:** The final replay snapshot matches the live snapshot

**Scenario:** *The workflow documentation is complete*

- **Given:** A developer needs live or replay Studio behavior
- **When:** They read the Studio and architecture documentation
- **Then:** The commands, URL parameters, limits, isolation, and non-execution boundary are clear

## Technical Details

Add mapped unit tests for startup parsing and state transitions. Add browser or
integration coverage for HMR proxy behavior, production static serving, replay
startup and endpoint behavior, live and replay isolation, and the no-ingestion
guarantee. Update Studio README, architecture index, spec.studio-vite-development-and-isolated-replay index, and
recording examples.

## Out of Scope

- Changing existing Studio lifecycle or trust rules
- Adding a remote or durable Studio service
- Adding new canonical execution events

## Source

- [adr.studio-vite-development-and-isolated-replay](../adrs/2026-09-02-studio-vite-development-and-isolated-replay.md)
- [spec.studio-vite-development-and-isolated-replay](../specs/2026-09-02-studio-vite-development-and-isolated-replay.md)
- [task.boundary-verification-and-documentation: Verify event boundaries and documentation](./2026-09-02-boundary-verification-and-documentation.md)

## Traceability

- [spec.studio-vite-development-and-isolated-replay](../specs/2026-09-02-studio-vite-development-and-isolated-replay.md)
