---
id: task.wire-opencode-execution-into-runner
title: Wire OpenCode execution into the runner
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.opencode-executor-integration
supersedes: []
---

# Wire OpenCode execution into the runner

> Migrated from implementation story `TS-004-04`.

## Use Case

**As a** Seqlane operator, **I want to** run an authored OpenCode workflow through the existing CLI and child runner, **so that** OpenCode execution retains the established ownership and IPC boundaries.

## Scope

- Export a structural runner-execution factory from `@seqlane/opencode`.
- Let an authored workflow module create that factory from its workflow definition without separate task registration.
- Create the OpenCode adapter and executor registry inside the child runner.
- Pass the existing validated OpenCode connection to that factory.
- Preserve existing Plan, Plan-factory, and fixture execution seams.
- Cover an authored OpenCode workflow through the real child runner and CLI supervisor with the fake server.

## Out of Scope

- New CLI flags, workflow discovery, or runner protocol fields.
- OpenCode SDK imports in the CLI or core package.
- Persistent runner state or server lifecycle management.

## Implementation Notes

The runtime remains generic and uses only its Seqlane executor interface. The workflow module supplies the structural execution factory. The CLI continues to send only `RunRequest` and render JSON-only Seqlane events. The runner owns the client, session, executor registry, and task-definition registry.

## Acceptance Criteria

**Scenario:** *The runner owns OpenCode execution state*
- **Given:** A workflow module that exports an authored OpenCode workflow and its OpenCode runner-execution factory
- **When:** `seqlane run` starts the child runner
- **Then:** The child loads the module, creates the OpenCode execution state, and the CLI receives only existing serialized lifecycle events

**Scenario:** *Existing execution forms remain supported*
- **Given:** Existing Plan, Plan-factory, and fake-executor fixture modules
- **When:** Their runner contract tests execute
- **Then:** They retain their current loading and execution behavior

**Scenario:** *No OpenCode object crosses IPC*
- **Given:** An OpenCode-backed workflow Run
- **When:** The parent and child protocol messages are inspected
- **Then:** They contain no SDK client, session ID, message ID, SDK error, or raw OpenCode event

## Source

- [rfc.seqlane-technical-architecture — Seqlane Technical Architecture](../rfcs/2026-09-02-seqlane-technical-architecture.md)
- [adr.opencode-executor-integration — Integrate OpenCode Through a Seqlane-Owned Executor Boundary](../adrs/2026-09-02-opencode-executor-integration.md)
- [spec.opencode-executor-integration — OpenCode Executor Integration](../specs/2026-09-02-opencode-executor-integration.md)
- [MVP — Dedicated Runner Process](../prd/2026-09-02-seqlane.md)

## Traceability

- [spec.opencode-executor-integration](../specs/2026-09-02-opencode-executor-integration.md)
