---
id: task.replace-descriptor-forwarding
title: Replace Descriptor Forwarding with Local Studio Ownership
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.local-development-studio-trust-and-lifecycle
supersedes: []
---

# Replace Descriptor Forwarding with Local Studio Ownership

> Migrated from implementation story `TS-014-01`.

## User outcome

As a local developer, I can use `seqlane run --studio` without manually
creating or selecting a descriptor file.

## Scope

- Change `--studio` to a boolean flag.
- Resolve the configured local Studio address deterministically.
- Reuse a running standalone Studio.
- Start and stop an owned Studio around a one-shot run.
- Preserve best-effort forwarding and runner exit status.

## Out of scope

- Changes to runner IPC or event schemas.
- Remote Studio discovery.
- Persistent Studio processes.

## Implementation notes

- Update the CLI Studio/run commands and publisher API.
- Use `finally` for owned-session cleanup.
- Ensure standalone Studio is never stopped by a run that reuses it.

## Acceptance criteria

```gherkin
Scenario: Run with an existing standalone Studio
  Given a standalone Studio is available on the configured port
  When the user runs a workflow with --studio
  Then runner events are forwarded to that Studio
  And the Studio remains running after the workflow ends

Scenario: Run with an owned Studio
  Given no Studio is available on the configured port
  When the user runs a workflow with --studio
  Then the CLI starts a Studio
  And forwards events to it without a descriptor or capability header
  And stops that Studio after the run settles

Scenario: Studio forwarding fails
  Given Studio is unavailable during a run
  When the workflow completes
  Then the workflow result and exit status remain unchanged
  And the CLI reports a diagnostic
```

## Source

- [adr.local-development-studio-trust-and-lifecycle](../adrs/2026-09-02-local-development-studio-trust-and-lifecycle.md)
- [spec.local-development-studio-trust-and-lifecycle](../specs/2026-09-02-local-development-studio-trust-and-lifecycle.md)

## Traceability

- [spec.local-development-studio-trust-and-lifecycle](../specs/2026-09-02-local-development-studio-trust-and-lifecycle.md)
