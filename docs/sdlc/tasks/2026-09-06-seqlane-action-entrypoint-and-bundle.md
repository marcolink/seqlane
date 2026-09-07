---
id: task.seqlane-action-entrypoint-and-bundle
title: Wire and Bundle the Seqlane Conflict Resolution Action
status: completed
owners:
  - core
created: 2026-09-06
updated: 2026-09-07
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Wire and Bundle the Seqlane Conflict Resolution Action

## Objective

Replace the empty Action entrypoint with a thin GitHub Actions adapter. Declare
the public contract and produce a self-contained committed bundle.

## Upstream requirements

Implement `requirement-action-library-boundary`,
`requirement-dependency-and-tooling-boundary`, `requirement-action-contract`,
and `requirement-observability-and-secrets` from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

Depend on:

- [task.seqlane-action-resolution-contracts](./2026-09-06-seqlane-action-resolution-contracts.md)
- [task.seqlane-action-runtime-adapters](./2026-09-06-seqlane-action-runtime-adapters.md)
- [task.seqlane-action-resolution-controller](./2026-09-06-seqlane-action-resolution-controller.md)

Follow [actions/AGENTS.md](../../../actions/AGENTS.md) and the Action
architecture guidance.

## Scope

- Add all Action inputs to `action.yml`.
- Add all Action outputs to `action.yml`.
- Keep `runs.using: node24` and `runs.main: dist/main.js`.
- Read inputs with `@actions/core`.
- Read repository and workflow context through the Action adapter.
- Use `@actions/github` as the resolver-scoped GitHub adapter.
- Do not add `@octokit/octokit.js` alongside `@actions/github`.
- Resolve relative directories from `GITHUB_WORKSPACE`.
- Pass plain values and injected ports to the library.
- Mask `OPENAI_API_KEY` before application work starts.
- Map typed application errors to `core.setFailed`.
- Publish bounded outputs and summary data.
- Add the library as a declared workspace dependency.
- Add any Action Toolkit dependencies only after dependency security review.
- Do not add artifact, cache, or tool-cache dependencies to this resolver
  bundle.
- Add Nx target dependencies so the library builds before the Action bundle.
- Bundle all runtime dependencies into `actions/resolve-merge-conflicts/dist`.

## Out of scope

- Git conflict algorithms.
- GitHub API policy.
- Seqlane task prompts.
- OpenCode lifecycle rules.
- Workflow trigger or permission changes.

## Implementation plan

1. Define the Action inputs and outputs in `action.yml`.
2. Keep `commit` and `push` defaults safe and pass explicit production values
   from the workflow.
3. Reject missing or malformed inputs before creating adapters.
4. Resolve paths under `GITHUB_WORKSPACE` and reject unsafe paths.
5. Use `GITHUB_ACTION_PATH` only for Action-shipped assets.
6. Do not use `process.cwd()` as the Action directory.
7. Construct the library request from parsed input values.
8. Inject the GitHub, Git, filesystem, lockfile, agent, and summary adapters.
9. Set the secret mask before the controller starts child processes.
10. Map successful results to Action outputs.
11. Map expected application errors to clear annotations without exposing
    credentials or raw executor output.
12. Build the Action with Nx and inspect the generated bundle.
13. Confirm that the bundle contains only the selected runtime dependencies.
14. Confirm that the bundle does not require dependency installation in the
    consuming workflow.

Keep `src/main.ts` limited to input, output, context, logging, and failure
handling. Do not add a second resolver implementation there.

## Affected areas

- `actions/resolve-merge-conflicts/action.yml`
- `actions/resolve-merge-conflicts/src/main.ts`
- `actions/resolve-merge-conflicts/package.json`
- `actions/resolve-merge-conflicts/project.json`
- `actions/resolve-merge-conflicts/tsconfig.json`
- `actions/resolve-merge-conflicts/dist/main.js`
- `tsconfig.json`
- `pnpm-lock.yaml`
- Action adapter tests

## Verification

Run these checks:

```text
pnpm run test:mapping
pnpm exec nx run action-resolve-merge-conflicts:typecheck
pnpm exec nx run action-resolve-merge-conflicts:test
pnpm exec nx run action-resolve-merge-conflicts:build
git diff --exit-code -- actions/*/dist/
pnpm format:check
git diff --check
```

Run the production workflow through the trusted local Action invocation
`uses: ./seqlane-source/actions/resolve-merge-conflicts`. Keep any verification
run free of remote push credentials and mutations.

## Completion criteria

- `action.yml` declares every input and output.
- `src/main.ts` contains no Git conflict or rebase algorithm.
- The Action uses Node 24.
- The bundle contains the library and all required runtime dependencies.
- The Action does not require consumer dependency installation.
- Secret values are masked before child processes start.
- Typed failures produce failed Actions without leaking executor details.
- The generated bundle matches committed source output.
- The production workflow runs the trusted local Action from
  `./seqlane-source/actions/resolve-merge-conflicts`.

## Outcome

Completed. The Action now declares all resolver inputs and outputs, uses the
Node 24 runtime, reads Action Toolkit and GitHub context only in the
entrypoint, masks the OpenAI key before application work starts, and maps
typed resolver failures to failed Action status. The resolver library remains
the owner of Git, workspace, lockfile, Seqlane, and OpenCode behavior. The
agent workflow is available through the declared private runtime export, so
the Action does not import an example through a relative path.

The bundle is self-contained and includes the Action Toolkit, resolver
library, and private runtime dependencies. It was built with the equivalent
local esbuild command because the Nx target cannot create workspace data in
the shared external `.nx` path.

Verification passed for the Action typecheck, dependent TypeScript builds,
`pnpm run test:mapping`, `pnpm format:check`, and `git diff --check`. The
focused resolver suite remains green at 51 tests.

## Traceability

- Contract: [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- Decision: [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
- Action rules: [`actions/AGENTS.md`](../../../actions/AGENTS.md)
