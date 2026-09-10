---
id: task.harden-zvec-grep-index-policy-and-entrypoint
title: Harden zvec-grep Index Policy and Entrypoint
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - spec.zvec-grep-action-owned-indexing
supersedes: []
---

# Harden zvec-grep Index Policy and Entrypoint

## Objective

Prevent sensitive JSON/YAML and credential material from entering the
zvec-grep index, and keep the Action entrypoint limited to Action adaptation.

## Upstream requirements

Implement the file-policy and private-lifecycle requirements in
[spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md).

## Scope

- Extend immutable index exclusions for sensitive configuration, credential,
  token, service-account, certificate, and private-key patterns.
- Add representative exclusion-policy tests.
- Extract zvec resolve/index/server/readiness and cleanup orchestration from
  the Action entrypoint into a private Action module.
- Preserve inputs, outputs, command arguments, trusted cwd, and lifecycle
  behavior.
- Rebuild the committed Action bundle and update SDLC indexes.

## Out of scope

- Repository-wide indexing limits or a new resource-limit input.
- Action bundle conversion from ESM to CommonJS.
- Changes to zvec-grep itself, package-manager behavior, or MCP protocol.

## Implementation plan

1. Add failing command-policy tests for representative sensitive filenames.
2. Expand immutable exclusions without permitting additional glob overrides.
3. Move lifecycle orchestration to a private Action module and retain a thin
   Action adapter.
4. Rebuild the bundle and run Action, documentation, mapping, and workflow
   verification.

## Affected areas

- `actions/zvec-grep-server/src/`
- `actions/zvec-grep-server/dist/main.js`
- `docs/sdlc/specs/2026-09-07-zvec-grep-action-owned-indexing.md`
- `docs/sdlc/tasks/2026-09-07-harden-zvec-grep-index-policy-and-entrypoint.md`

## Verification

Run focused Action tests, typecheck, bundle drift, test mapping, formatting,
`git diff --check`, `pnpm docs:index`, and `pnpm docs:validate`. Run
`actionlint` when available.

## Completion criteria

- Representative sensitive filenames match immutable exclusions.
- Additional globs cannot weaken sensitive-file exclusions.
- The Action entrypoint delegates lifecycle orchestration to a private module.
- The rebuilt bundle matches source and all affected checks pass.

## Outcome

Expanded immutable exclusions for private-key and certificate extensions plus
secret, credential, token, service-account, and auth JSON/YAML filename
patterns. Added regression coverage that preserves exclusion ordering after
caller-supplied globs.

Moved resolve, index, startup, readiness, state persistence, and cleanup into
the private `lifecycle.ts` module. The Action entrypoint now adapts inputs and
outputs, preserves the shipped-anchor compatibility export, and delegates the
lifecycle.

Focused Action tests (23), typecheck, bundle drift, formatting, test mapping,
SDLC index/validation, and `git diff --check` passed. `actionlint` was not
installed.

## Traceability

- [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
