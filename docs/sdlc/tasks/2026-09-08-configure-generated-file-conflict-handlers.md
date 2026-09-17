---
id: task.configure-generated-file-conflict-handlers
title: Configure Generated-File Conflict Handlers
status: completed
owners:
  - core
created: 2026-09-08
updated: 2026-09-17
upstream:
  - spec.seqlane-action-merge-conflict-resolution
  - adr.seqlane-action-library-boundary
supersedes: []
---

# Configure Generated-File Conflict Handlers

Historical path note: `examples/README.md` was superseded by `workflows/README.md`.

## Objective

Allow a trusted workflow revision to provide a repository-specific static JSON
policy for mechanically resolving conflicts in generated files. Execute each
selected handler in an isolated environment, validate its output globs, and
fail the resolution attempt when any handler phase fails.

## Upstream requirements

Implement
[`requirement-generated-file-handlers`](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md#requirement-generated-file-handlers)
and the workflow boundary in
[`requirement-workflow-host`](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md#requirement-workflow-host).
Preserve the Action-specific library boundary in
[`adr.seqlane-action-library-boundary`](../adrs/2026-09-06-seqlane-action-library-boundary.md).

## Scope

- Add the formatted multiline JSON `conflict-handlers` Action input from the
  trusted workflow revision.
- Parse the JSON policy with a strict runtime schema; do not load it from the
  resolution target.
- Validate repository-relative `match` globs, non-empty `outputs` glob lists,
  and nested `handler` recipes before target mutation. Keep the built-in
  `pnpm-lock.yaml` regeneration path outside policy override and require no
  policy rule for it.
- Classify generated-file conflicts before agent and lockfile handling.
- Execute matching handlers mechanically with argument arrays and no model
  fallback.
- Isolate handler setup and commands from Action secrets, credentials, and the
  normal workflow process.
- Validate the complete changed-path set against each handler's output globs,
  stage only approved original conflict paths, and reject unresolved entries.
- Add the trusted workflow toolchain bootstrap with pinned Node/pnpm and
  frozen trusted-source dependencies, with lifecycle scripts disabled.
- Keep target dependency installation handler-specific and inside the isolated
  handler environment.
- Add policy, matching, output-allowlist, failure, and integration tests.
- Update Action metadata, workflow operator documentation, and committed
  Action output as required by the implementation.

## Out of scope

- Loading policy from the resolution-target checkout.
- Accepting policy contents from the resolution target or selecting handlers
  through model output.
- Allowing the model to select, modify, or recover a generated-file handler.
- Falling back to Git stage 3, the model, or another handler after failure.
- Changing the existing OpenCode policy or agent workspace contract.
- Executing target dependencies in the normal workflow process.
- Broadening the resolver into a general Action or build-execution framework.

## Implementation plan

1. Define the strict policy schema and Action input mapping. Reject malformed,
   ambiguous, absolute, or traversal-containing globs and unsupported handler
   recipes before Git mutation.
2. Add deterministic conflict classification and handler grouping. Ensure
   generated-file paths are excluded from model resolution and remain covered
   by the original conflict allowlist.
3. Implement the isolated handler runner with structured executable and
   argument arrays, no Action secrets or credentials, bounded temporary
   workspaces, and disabled or explicitly allowlisted network access.
4. Run each handler's setup and command, validate that all changed paths match
   its `outputs` globs, and fail the complete attempt on any setup, command,
   output, sandbox, or staging failure.
5. Add the trusted-source workflow bootstrap and pass the static JSON policy
   from the trusted workflow revision. Do not install target dependencies
   outside the isolated handler runner.
6. Add real temporary-repository tests for generated-only, mixed, repeated
   rebase-stop, unexpected-output, command-failure, and secret-isolation
   scenarios. Rebuild and verify the committed Action bundle.

## Affected areas

- `actions/resolve-merge-conflicts/action.yml`
- `actions/resolve-merge-conflicts/src/main.ts`
- `actions/resolve-merge-conflicts/dist/main.js`
- `libs/action-merge-conflict-resolution/src/`
- `libs/action-merge-conflict-resolution/*spec.ts`
- `.github/workflows/seqlane-resolve-merge-conflicts.yml`
- `examples/README.md`
- workflow and Action integration tests

## Verification

Run these checks in dependency order:

```text
pnpm run test:mapping
pnpm exec nx run action-merge-conflict-resolution:typecheck
pnpm exec nx run action-merge-conflict-resolution:test
pnpm exec nx run action-resolve-merge-conflicts:typecheck
pnpm exec nx run action-resolve-merge-conflicts:test
pnpm exec nx run action-resolve-merge-conflicts:build
git diff --exit-code -- actions/*/dist/
pnpm docs:index
pnpm docs:validate
pnpm docs:test
pnpm format:check
git diff --check
```

The focused integration tests must prove that invalid policy, ambiguous
matching, changed paths outside `outputs`, handler command failure, setup
failure, and remaining conflicts fail closed. They must also prove that
target-provided code cannot read the Action secrets or push credentials.

## Completion criteria

- The trusted workflow passes a versioned formatted multiline JSON
  `conflict-handlers` policy.
- Each JSON rule has repository-relative `match` and non-empty `outputs` globs
  and a nested `handler` recipe.
- The built-in `pnpm-lock.yaml` regeneration path works without a policy rule
  and cannot be overridden.
- Generated-file conflicts are handled mechanically and never sent to the
  model.
- Every handler failure fails the resolution attempt with no fallback.
- Unexpected changed paths and unresolved index entries are rejected before
  continuation, commit, or push.
- Handler execution is isolated, unprivileged, and free of Action secrets and
  credentials.
- Trusted-source toolchain setup is distinct from target dependency setup.
- The Action bundle, workflow, operator documentation, and SDLC traceability
  agree with the implemented contract.

## Outcome

Completed. The trusted workflow now passes the formatted multiline JSON
`conflict-handlers` input with nested handler recipes. Generated-file conflicts
are classified and handled mechanically before agent work; handler setup,
command, output-validation, sandbox, and staging failures fail the attempt and
prevent agent startup. The built-in `pnpm-lock.yaml` regeneration remains
separate, follows agent resolution, and cannot be overridden by policy.

Focused and full resolver/action tests, type checks, Action bundle build and
drift checks, workflow smoke tests, test mapping, formatting, and Git diff
checks passed. `pnpm docs:index`, `pnpm docs:validate`, and `pnpm docs:test`
also passed. Delivery is tracked in [PR #77](https://github.com/marcolink/seqlane/pull/77).

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Architecture: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- Delivery: [PR #77](https://github.com/marcolink/seqlane/pull/77)
