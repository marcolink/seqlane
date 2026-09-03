---
id: task.opencode-profile-transitions
title: Resolve OpenCode Profiles and Guard Session Transitions
status: planned
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.runtime-resolved-execution-profiles
supersedes: []
---

# Resolve OpenCode Profiles and Guard Session Transitions

> Migrated from implementation story `TS-018-03`.

## User outcome

As a workflow operator, I can use different safe model profiles in one Run,
and Seqlane never creates a hidden replacement OpenCode session.

## Scope

- Resolve runtime agent profiles to OpenCode agents and effective behavior.
- Apply the exact OpenCode configuration at supported session setup.
- Classify same-profile and model-only transitions.
- Allow safe prompt-level transitions.
- Reject tool, permission, gateway, and unsupported session changes.
- Guard runtime transitions after static preflight.

## Out of scope

- Multiple sessions per Run.
- Explicit session boundaries.
- Context handoff or summarization.
- Task-level policy overlays.
- Direct model IDs in workflow source.

## Implementation notes

The first invocation establishes the session profile. A model-only transition
can use OpenCode prompt-level selection when the adapter proves that behavior
safe. OpenCode agent configuration remains the source of truth for tools and
permissions. The adapter must fail rather than start a replacement session.

## Acceptance criteria

**Scenario:** *The initial profile starts the session*

- **Given:** Preflight resolves the first task profile
- **When:** Seqlane creates the OpenCode session
- **Then:** It applies the validated configuration and emits no transition warning

**Scenario:** *A safe model change continues the session*

- **Given:** Two profiles differ only by model and OpenCode supports prompt-level selection
- **When:** The second task starts
- **Then:** Seqlane reuses the session and records a model-change warning

**Scenario:** *A tool change is unsafe*

- **Given:** Two profiles differ in tool policy and the adapter cannot apply it safely per prompt
- **When:** Preflight or the runtime transition guard evaluates the change
- **Then:** Seqlane fails before the affected task runs and does not create another session

**Scenario:** *A gateway change is requested*

- **Given:** A task profile resolves to a different gateway
- **When:** Seqlane evaluates the transition
- **Then:** Seqlane fails because multi-session execution is not available

**Scenario:** *The adapter cannot apply configuration*

- **Given:** OpenCode does not support the requested session setup path
- **When:** The adapter initializes
- **Then:** Seqlane fails instead of ignoring or silently changing configuration

## Source

- [adr.runtime-resolved-execution-profiles](../adrs/2026-09-02-runtime-resolved-execution-profiles.md)
- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)

## Traceability

- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)
