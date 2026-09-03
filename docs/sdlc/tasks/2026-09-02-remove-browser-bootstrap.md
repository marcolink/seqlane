---
id: task.remove-browser-bootstrap
title: Remove Browser Bootstrap Workflow and Update Documentation
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.local-development-studio-trust-and-lifecycle
supersedes: []
---

# Remove Browser Bootstrap Workflow and Update Documentation

> Migrated from implementation story `TS-014-02`.

## User outcome

As a local developer, I can refresh Studio after a restart without a stale
bootstrap URL or browser cookie, and the documented commands match the new
workflow.

## Scope

- Remove browser bootstrap assumptions from the client and service boundary.
- Update Studio, CLI, root, and spec.local-read-only-execution-studio-adjacent documentation as needed.
- Add direct-load and refresh coverage.

## Out of scope

- New graph editing behavior.
- Durable browser state.
- Remote or authenticated deployment.

## Implementation notes

- Keep the browser API projection and SSE behavior unchanged.
- Replace descriptor/bootstrap examples with direct local URLs and boolean
  `--studio` usage.
- Document standalone and one-shot lifecycle differences.

## Acceptance criteria

```gherkin
Scenario: Open Studio directly
  Given Studio is running on the loopback port
  When the user opens /
  Then the client loads without a bootstrap redirect
  And no session cookie is required

Scenario: Refresh after restart
  Given the previous Studio process has stopped
  When a new Studio process starts
  And the user refreshes the direct root URL
  Then Studio loads without a stale-session error

Scenario: Documentation shows the supported workflow
  Given the repository documentation is read
  Then it contains no required descriptor or bootstrap-token workflow
  And it documents standalone and one-shot Studio behavior
```

## Source

- [adr.local-development-studio-trust-and-lifecycle](../adrs/2026-09-02-local-development-studio-trust-and-lifecycle.md)
- [spec.local-development-studio-trust-and-lifecycle](../specs/2026-09-02-local-development-studio-trust-and-lifecycle.md)

## Traceability

- [spec.local-development-studio-trust-and-lifecycle](../specs/2026-09-02-local-development-studio-trust-and-lifecycle.md)
