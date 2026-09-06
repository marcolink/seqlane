---
name: seqlane-github-action-development
description: Create, modify, test, debug, or package TypeScript GitHub Actions in the Seqlane monorepo, including local actions and reusable workflows.
---

# Seqlane GitHub Action Development

Use the repository's established action architecture and obey the nearest
`AGENTS.md`.

## Establish context

1. Read the root `AGENTS.md` and the scoped instructions under `actions/` or
   `.github/workflows/`.
2. Inspect the target `action.yml`, source, tests, package manifest, Nx target,
   and committed bundle.
3. Determine whether the requested capability should be:
   - a JavaScript Action,
   - a composite action, or
   - a reusable workflow.

Use a JavaScript Action for reusable TypeScript behavior. Use a composite
action for small step-level glue. Use a reusable workflow for complete jobs,
permissions, runner selection, and surrounding CI orchestration.

## Implement

- Keep the action entrypoint thin.
- Place reusable behavior in an appropriate workspace package.
- Keep the public contract in `action.yml`.
- Bundle all runtime dependencies.
- Preserve existing public inputs and outputs unless the task explicitly
  changes the contract.

Read [references/architecture.md](references/architecture.md) when introducing
an action, moving action code, or changing package boundaries.

Read [references/workflows.md](references/workflows.md) when creating or
changing a reusable workflow or an action's workflow invocation.

## Verify

Read [references/testing.md](references/testing.md) whenever action behavior,
metadata, bundling, Git behavior, or workflow integration changes.

At minimum:

1. Typecheck.
2. Run unit tests.
3. Run relevant integration tests.
4. Rebuild the bundle.
5. Verify no bundle drift remains.
6. Run the local action integration workflow when applicable.

Report source changes and generated bundle changes separately.
