---
id: task.seqlane-action-resolution-contracts
title: Establish Seqlane Action Resolution Contracts
status: completed
owners:
  - core
created: 2026-09-06
updated: 2026-09-08
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Establish Seqlane Action Resolution Contracts

## Objective

Create the private `libs/action-merge-conflict-resolution` package.
Define the typed contracts and pure policies that the remaining resolver tasks
will use.

## Upstream requirements

Implement the contracts in
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md),
especially `requirement-action-library-boundary`,
`requirement-action-contract`, `requirement-pull-request-preflight`, and
`requirement-conflict-attempts`.

Respect these decisions:

- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- [adr.executor-neutral-workflow-authoring](../adrs/2026-09-02-executor-neutral-workflow-authoring.md)
- [adr.autonomous-non-interactive-execution](../adrs/2026-09-02-autonomous-non-interactive-execution.md)

## Scope

- Add `libs/action-merge-conflict-resolution` as a private Nx library.
- Use the package name `@seqlane/action-merge-conflict-resolution`.
- Document the package as resolver-specific Action infrastructure, not as a
  generic GitHub Action support package or Seqlane application package.
- Keep `libs/seqlane-core`, `libs/seqlane-runtime`, the CLI, and generic
  workflow packages independent of this package.
- Use the existing OSS GitHub communication package through a narrow resolver
  adapter. Do not create a general GitHub client layer.
- Add package exports and declared workspace dependencies.
- Add Zod schemas for Action inputs, Git revisions, branch names, strategies,
  pull-request metadata, conflict paths, and resolver results.
- Add typed errors with stable categories and original causes.
- Add pure policy functions for input validation, conflict classification,
  attempt limits, push permission, and terminal outcomes.
- Add a pure resolution-attempt state model.
- Add tests for valid values, malformed values, limits, and policy outcomes.
- Add test-scope annotations for every cross-module test.

## Out of scope

- Git CLI calls.
- GitHub API calls.
- Filesystem copying.
- Docker or lockfile execution.
- OpenCode startup.
- Seqlane execution.
- Action Toolkit calls.
- Workflow YAML changes.

## Implementation plan

1. Create the package manifest, project configuration, TypeScript project, and
   source index.
2. Define one canonical schema for each shared contract.
3. Keep Action input parsing separate from the application request model.
4. Define the result union for clean integration, resolved integration, and
   typed operational errors.
5. Define the conflict set model with path and index-stage information.
6. Define the attempt phases and transitions without process or filesystem
   effects.
7. Define the default attempt limit as `10`.
8. Define the agent and lockfile classification rule for `pnpm-lock.yaml`.
9. Define explicit `commit` and `push` permissions with safe defaults of
   `false`.
10. Add tests that prove the policy does not depend on error-message text.

Do not add handwritten runtime predicates for schema-backed values. Use Zod
schemas as the source of truth.

## Affected areas

- `libs/action-merge-conflict-resolution/package.json`
- `libs/action-merge-conflict-resolution/project.json`
- `libs/action-merge-conflict-resolution/tsconfig.json`
- `libs/action-merge-conflict-resolution/src/contracts.ts`
- `libs/action-merge-conflict-resolution/src/errors.ts`
- `libs/action-merge-conflict-resolution/src/policy.ts`
- `libs/action-merge-conflict-resolution/src/resolution-state.ts`
- `libs/action-merge-conflict-resolution/src/index.ts`
- colocated contract and policy tests
- `tsconfig.json`
- `pnpm-lock.yaml`

## Verification

Run these checks after the package exists:

```text
pnpm run test:mapping
pnpm exec nx run action-merge-conflict-resolution:typecheck
pnpm exec nx run action-merge-conflict-resolution:test
pnpm docs:validate
pnpm format:check
git diff --check
```

Inspect the package exports and confirm that no source file imports
`@actions/core`, `@actions/github`, OpenCode, or GitHub event globals.

## Completion criteria

- The package path is `libs/action-merge-conflict-resolution`.
- The package name is `@seqlane/action-merge-conflict-resolution`.
- The package does not contain generic GitHub, OpenCode, or service Action
  support.
- The package contains no GitHub Action Toolkit imports or Seqlane application
  dependency in the reverse direction.
- The package has a declared private workspace identity.
- Schemas and inferred types cover every application boundary value.
- Policy tests cover invalid strategies, invalid revisions, invalid paths,
  empty conflict sets, lockfile classification, limits, and push permissions.
- Pure state transitions cover clean integration, conflicted integration,
  successful continuation, empty-commit continuation, attempt-limit failure,
  and terminal completion.
- The package builds without Action Toolkit or GitHub runtime state.
- Test mapping passes.

## Outcome

Completed. Added the private `@seqlane/action-merge-conflict-resolution`
package with schema-backed contracts, stable typed errors, pure resolver
policies, resolution-attempt state transitions, package exports, and colocated
tests. The package remains independent of GitHub Action Toolkit types,
OpenCode, Seqlane application packages, and workflow code.

Verification passed for `pnpm install --frozen-lockfile`, `pnpm run
test:mapping`, the package TypeScript typecheck and build, the package Vitest
suite (15 tests), `pnpm docs:validate`, `pnpm format:check`, and `git diff
--check`. Nx target execution was also attempted, but the local Nx workspace
data lock resolves to `/Users/marco.link/projects/contentful/taskflow/.nx`,
outside this worktree's writable scope; the direct package checks passed.

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
