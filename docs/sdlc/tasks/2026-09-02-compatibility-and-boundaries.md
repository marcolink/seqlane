---
id: task.compatibility-and-boundaries
title: Complete Compatibility, Security, and Boundary Coverage
status: planned
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.runtime-resolved-execution-profiles
supersedes: []
---

# Complete Compatibility, Security, and Boundary Coverage

> Migrated from implementation story `TS-018-05`.

## User outcome

As a Seqlane maintainer, I can verify that agent profiles do not weaken
executor-neutral boundaries or break workflows that use runtime defaults.

## Scope

- Verify workflows without agent keys remain compatible with a valid runtime
  default.
- Verify hand-authored Plans use only the runtime default.
- Add malformed-input and secret-redaction coverage.
- Add core, Plan, runner IPC, package, and built-in boundary tests.
- Update package documentation and architecture references.
- Run the repository verification gate.

## Out of scope

- Direct model ID support.
- Multi-session execution.
- Profile overlays.
- New runtime configuration commands.
- Unrelated ADR or documentation cleanup.

## Implementation notes

Keep OpenCode configuration and resolved profiles private. Check that warning
events use the canonical package. Preserve the pre-existing recording and
replay limits. Run test-mapping checks before the full suite.

## Acceptance criteria

**Scenario:** *An existing workflow omits agent keys*

- **Given:** A workflow has no workflow or task agent key
- **When:** A runtime provides a valid default profile
- **Then:** The workflow runs with the default profile and its Plan remains unchanged

**Scenario:** *A hand-authored Plan runs*

- **Given:** A Plan contains no agent metadata
- **When:** The runtime executes it
- **Then:** The runtime uses its default profile and does not infer task profiles

**Scenario:** *A boundary test inspects public artifacts*

- **Given:** Core exports, Plans, runner commands, or built-in workflows are inspected
- **When:** The boundary checks run
- **Then:** They contain no OpenCode configuration, credentials, provider IDs, or resolved profile data

**Scenario:** *A secret appears in invalid configuration*

- **Given:** Adapter configuration fails with a secret-bearing value
- **When:** The runtime reports the failure or warning
- **Then:** The secret is redacted from diagnostics and events

**Scenario:** *Repository verification runs*

- **Given:** All spec.runtime-resolved-execution-profiles stories are implemented
- **When:** The repository verification gate runs
- **Then:** Test mapping, typecheck, tests, lint, build, formatting, sync checks, and diff checks pass

## Source

- [adr.runtime-resolved-execution-profiles](../adrs/2026-09-02-runtime-resolved-execution-profiles.md)
- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)

## Traceability

- [spec.runtime-resolved-execution-profiles](../specs/2026-09-02-runtime-resolved-execution-profiles.md)
