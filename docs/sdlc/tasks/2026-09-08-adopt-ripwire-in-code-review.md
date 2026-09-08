---
id: task.adopt-ripwire-in-code-review
title: Adopt Ripwire in Seqlane Code Review
status: completed
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
- Document the provider-specific review path rule: native read, glob, and grep
  use workspace-relative paths; zvec-grep receives the exact workspace root;
  Ripwire calls omit `path` and `paths` and use its pinned review-workspace
  root.
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
4. Keep shared review-task instructions provider-specific and bounded: do not
   force indexed searches when native evidence is sufficient.
5. Align the active spec and example documentation, then regenerate indexes.

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
- Run a GitHub-hosted manual dispatch of `Seqlane code review` and verify that
  both service Actions start, OpenCode loads both MCP servers, the review
  publishes, and all service post hooks run. Separately issue a successful
  authenticated read-only Ripwire tool call against the Action-managed
  service.
- Run Prettier on changed files and the repository formatting check.
- Run `git diff --check` and `actionlint` when available.

## Completion criteria

- The workflow starts both providers against `review-target`, preserves zvec,
  and configures Ripwire with its generated URL and bearer token.
- OpenCode retains `*` denied, permits the 27 Ripwire read-only tools, and
  denies all four Ripwire write-capable tools.
- Both review recording paths redact OpenAI and Ripwire token values.
- Review instructions scope native tools, zvec-grep, and Ripwire correctly and
  prohibit parent, runner, and trusted-source paths.
- The spec, task index, and examples describe the combined provider setup.

## Outcome

The code-review workflow now starts zvec-grep and Ripwire against the trusted
`review-target` checkout. OpenCode keeps default-deny permissions, preserves
the existing zvec-grep search tool, and exposes all 27 Ripwire read-only tools.
The four Ripwire write-capable tools remain denied. Ripwire uses a generated
bearer token, and both recording paths redact that token with the OpenAI key.

The review instructions now separate provider path rules. Native tools use
workspace-relative paths, zvec-grep receives the exact review root, and
Ripwire omits `path` and `paths` so its pinned root controls scope.

Local verification passed test mapping, all 45 code-review workflow tests,
YAML configuration extraction, documentation validation and tests, formatting,
and diff checks. The Action verification also passed typecheck, bundle build
and drift, and all 85 Ripwire tests. An authenticated local `analyze` call with
an omitted path succeeded against the Action-managed service.

GitHub-hosted workflow run `34206891601` used the branch workflow at commit
`f34fd6264857b7d2b9325e7a3f512e1e2cd5870b`. It started both service Actions,
loaded the authenticated dual-provider OpenCode configuration, completed and
published the review, and ran the OpenCode, Ripwire, and zvec-grep post hooks.
The published review approved the change with no required findings.

## Traceability

- [spec.ripwire-server-action](../specs/2026-09-08-ripwire-server-action.md)
- [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
- [task.add-ripwire-server-action](./2026-09-08-add-ripwire-server-action.md)
- [task.adopt-zvec-grep-action-owned-indexing](./2026-09-07-adopt-zvec-grep-action-owned-indexing.md)
