---
id: task.adopt-ripwire-in-code-review
title: Adopt Ripwire in Seqlane Code Review
status: in-progress
owners:
  - core
created: 2026-09-08
updated: 2026-09-08
upstream:
  - spec.ripwire-server-action
  - spec.zvec-grep-action-owned-indexing
supersedes: []
---

# Adopt Ripwire in Seqlane Code Review

## Objective

Add Ripwire as a second indexed, read-only code-navigation provider in the
trusted Seqlane pull-request review workflow while preserving zvec-grep.

## Upstream requirements

- Follow [spec.ripwire-server-action](../specs/2026-09-08-ripwire-server-action.md),
  especially [requirement-review-workflow-caller](../specs/2026-09-08-ripwire-server-action.md#requirement-review-workflow-caller).
- Preserve [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
  and the existing zvec workflow configuration.

## Scope

- Start `actions/ripwire-server` after the existing zvec-grep Action against
  `${{ github.workspace }}/review-target` with the approved fixed inputs and
  no seed token.
- Configure pinned OpenCode 1.18.27 with the generated Ripwire URL and token,
  the 27 read-only Ripwire tool permissions, and the existing default-deny
  zvec/read policy.
- Add the generated Ripwire token to both workflow recording redaction
  environments without removing the OpenAI key.
- Update the Ripwire spec, this task, and `examples/README.md`; refresh the
  generated SDLC task index.

## Out of scope

- Changes to `actions/ripwire-server`, `actions/zvec-grep-server`, or their
  bundles.
- Enabling Ripwire remote edits or allowing the four Ripwire write-capable
  tools.
- Changes to GitHub token permissions, checkout trust, or execution of
  untrusted pull-request code.

## Implementation plan

1. Add the bounded Ripwire startup step after zvec-grep and pass the explicit
   review-target inputs.
2. Add the authenticated Ripwire MCP configuration and read-only allowlist to
   the existing OpenCode policy.
3. Redact the generated Ripwire token in recording and export steps.
4. Align the active spec and example documentation, then regenerate indexes.

## Affected areas

- `.github/workflows/seqlane-code-review.yml`
- `docs/sdlc/specs/2026-09-08-ripwire-server-action.md`
- `docs/sdlc/tasks/2026-09-08-adopt-ripwire-in-code-review.md`
- `examples/README.md`
- `docs/sdlc/tasks/index.md`
- `apps/seqlane-cli/src/pr-code-review-example.spec.ts`

## Verification

- Parse `.github/workflows/seqlane-code-review.yml` with the repository's
  existing YAML mechanism.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run the focused `pr-code-review-example.spec.ts` test and `pnpm test:mapping`.
- Run Prettier on changed files and the repository formatting check.
- Run `git diff --check` and `actionlint` when available.

## Completion criteria

- The workflow starts both providers against `review-target`, preserves zvec,
  and configures Ripwire with its generated URL and bearer token.
- OpenCode retains `*` denied, permits the 27 Ripwire read-only tools, and
  denies all four Ripwire write-capable tools.
- Both review recording paths redact OpenAI and Ripwire token values.
- The spec, task index, and examples describe the combined provider setup.
- The task Outcome remains empty for parent reconciliation.

## Outcome

## Traceability

- [spec.ripwire-server-action](../specs/2026-09-08-ripwire-server-action.md)
- [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
- [task.add-ripwire-server-action](./2026-09-08-add-ripwire-server-action.md)
- [task.adopt-zvec-grep-action-owned-indexing](./2026-09-07-adopt-zvec-grep-action-owned-indexing.md)
