---
id: task.effect-boundaries-and-documentation
title: Complete Runtime Boundaries and Documentation
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.effect-runtime-integration
supersedes: []
---

# Complete Runtime Boundaries and Documentation

> Migrated from implementation story `TS-019-03`.

## User outcome

As a Seqlane maintainer, the runtime uses Effect without a Mastra dependency
or an engine-specific public contract.

## Scope

- Remove `@mastra/core` from the runtime package and lockfile.
- Remove all `@mastra` imports from the runtime package.
- Rename private runtime files and symbols that still describe Mastra.
- Prove that core, Plans, events, IPC, and executor payloads remain unchanged.
- Update runtime documentation and the adr.mastra-internal-workflow-engine status.
- Add malformed-input and boundary coverage where migration exposes a gap.

## Out of scope

- Public API redesigns, Effect Schema, `@effect/workflow`, concurrency,
  retries, durable execution, persistence, or resume.

## Implementation notes

Do not rewrite adr.mastra-internal-workflow-engine except for its status. Use package-boundary imports.
Keep the established Zod contracts and all executor-neutral boundaries.

## Acceptance criteria

**Scenario:** *Mastra is absent from the runtime*

- **Given:** The completed runtime package
- **When:** The dependency and source boundaries are inspected
- **Then:** `@mastra/core` is absent from runtime dependencies
- **And:** No runtime source imports `@mastra/*`

**Scenario:** *Public contracts stay compatible*

- **Given:** A workflow crosses the runner boundary
- **When:** The Effect runtime executes it
- **Then:** Plan, event, IPC, and executor payloads keep their existing shapes

**Scenario:** *Documentation names the private engine*

- **Given:** A maintainer reads the runtime documentation and ADR index
- **When:** They inspect the engine decision
- **Then:** The documents identify Effect as private runtime infrastructure
- **And:** adr.mastra-internal-workflow-engine states that adr.effect-private-runtime-engine supersedes it

## Source

- [adr.effect-private-runtime-engine](../adrs/2026-09-02-effect-private-runtime-engine.md)
- [spec.effect-runtime-integration](../specs/2026-09-02-effect-runtime-integration.md)

## Traceability

- [spec.effect-runtime-integration](../specs/2026-09-02-effect-runtime-integration.md)
