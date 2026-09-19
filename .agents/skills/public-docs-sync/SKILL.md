---
name: public-docs-sync
description: Keep the Seqlane VitePress public docs accurate after user-visible changes to workflow authoring, adapters, runtime behavior, or the run command.
---

# Public Docs Sync

Use this skill after changes that can affect the public Seqlane docs site. It
keeps `apps/docs/` aligned with the current target-branch implementation.

## Scope

The public site lives in `apps/docs/`. It is separate from canonical SDLC
records in `docs/sdlc/`.

The public site contains Introduction, Authoring workflows, Adapters, and
`seqlane run` reference pages. Do not add pages for other CLI commands unless
the user expands this scope.

Use VitePress code groups when installation instructions show npm, pnpm, and
Yarn commands.

## Inspect

1. Inspect the changed source, tests, manifests, and configuration.
2. Read the nearest matching page in `apps/docs/` and
   `apps/docs/.vitepress/config.ts`.
3. Update public docs when behavior, DSL contracts, runtime requirements,
   adapter capabilities, configuration, flags, setup, or output changes.
4. Update sidebar navigation when you add, remove, or rename a public page.

Describe only behavior that current source and tests support. Do not document
planned features, private implementation details, or an adapter capability that
the runtime does not expose.

For adapter or model claims, inspect the adapter capability contract and its
tests. For DSL behavior, inspect the public core contract and builder tests.
For `seqlane run`, inspect the command parser and CLI tests.

## Write

Keep examples minimal and runnable in context. Explain default behavior,
constraints, and ordering rules beside the relevant API or flag. Use direct
links between related workflow pages.

Do not publish `docs/sdlc/` content on the VitePress site.

## Validate

Run these checks after public docs change:

```sh
pnpm --dir apps/docs run build
pnpm exec prettier --check apps/docs
git diff --check
```

Report the updated public-doc paths and the exact validation state.
