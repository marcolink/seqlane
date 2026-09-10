---
id: task.harden-zvec-grep-review-execution
title: Harden zvec-grep Review Execution
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - spec.zvec-grep-action-owned-indexing
supersedes: []
---

# Harden zvec-grep Review Execution

## Objective

Harden the Action-owned zvec-grep lifecycle against untrusted project package
configuration, invalid listen addresses, and review-job startup timeouts.

## Upstream requirements

Implement [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md).

## Scope

- Run all package-manager phases from a trusted shipped Action directory while
  passing the reviewed project only as an explicit index argument.
- Validate and canonicalize listen input before package resolution or spawn,
  including bracketed IPv6 support.
- Increase only the zvec Action step timeout in the review workflow to ten
  minutes.
- Preserve the fixed index policy, defaults, runner-temp cache, service home,
  log output, cleanup, and argument-array command contract.
- Keep committed bundles loadable as ESM with their CommonJS dependency bridge.

## Out of scope

- Changes to zvec-grep, package-manager implementations, or service protocol.
- Changes to the review workflow's file allowlist or exclusions.
- Conversion of Action bundles to CommonJS.

## Implementation plan

1. Add failing tests for trusted cwd selection and listen parsing/normalization.
2. Separate package execution cwd from the reviewed project index argument and
   use one canonical listen parse result throughout startup.
3. Raise the zvec Action workflow timeout and align the active spec and README.
4. Rebuild committed ESM bundles and run focused Action, mapping, workflow,
   and SDLC verification.

## Affected areas

- `actions/zvec-grep-server/`
- `.github/workflows/seqlane-code-review.yml`
- `docs/sdlc/specs/2026-09-07-zvec-grep-action-owned-indexing.md`
- `docs/sdlc/tasks/`

## Verification

- Record a failing focused test result before implementation.
- Run Action tests, typecheck, build, ESM bundle-load, and bundle-drift checks.
- Run test mapping, workflow/action metadata parsing, `git diff --check`, and
  `pnpm docs:index` plus `pnpm docs:validate`.

## Completion criteria

- No package-manager command receives the reviewed project as `cwd`.
- Invalid or missing listen ports fail before resolve/index/server execution;
  valid IPv4 and supported IPv6 forms normalize consistently.
- The zvec Action step has a ten-minute timeout and other workflow policy is
  unchanged.
- Committed bundles remain loadable ESM modules with a CommonJS bridge and no
  bundle drift.

## Outcome

Implemented trusted package execution cwd selection, early canonical listen
validation, and the ten-minute zvec Action timeout. Preserved direct indexing,
the fixed allowlist/exclusions, 1M default, runner-temp cache, service home,
logs, cleanup, and argument-array contract. Updated the active spec, Action
README, and this task; prior task wording was corrected to describe loadable
ESM bundles with a CommonJS bridge.

Focused Action tests (19), Action typecheck, direct ESM bundle build/load and
drift, test mapping, YAML parsing, `git diff --check`, `pnpm docs:index`, and
`pnpm docs:validate` passed. The Nx target could not initialize because this
restricted worktree cannot write the shared `.nx/workspace-data` lock; native
`actionlint` was unavailable.

## Traceability

- [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
- [task.adopt-zvec-grep-action-owned-indexing](./2026-09-07-adopt-zvec-grep-action-owned-indexing.md)
- [task.configure-zvec-grep-action-indexing](./2026-09-07-configure-zvec-grep-action-indexing.md)
