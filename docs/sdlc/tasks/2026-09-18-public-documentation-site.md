---
id: task.public-documentation-site
title: Publish a Minimal Public Documentation Site
status: completed
owners:
  - core
created: 2026-09-18
updated: 2026-09-18
upstream:
  - prd.seqlane-on-mastra
supersedes: []
---

# Publish a Minimal Public Documentation Site

## Objective

Publish one small public VitePress landing page for developers evaluating
Seqlane. The page must explain the workflow and task model, show the `seqlane
run` entry point, and sell the value of controlled coding workflows without
promising behavior that is not shipped.

## Upstream requirements

Use the current product surface described by
[prd.seqlane-on-mastra](../prd/2026-09-03-seqlane-on-mastra.md): typed
workflows, coding and deterministic tasks, explicit session behavior, and the
non-interactive CLI. This task adds a presentation and hosting surface; it does
not redefine those requirements.

## Scope

- Add a repository-local VitePress app for the public site.
- Create one homepage with concise product copy, short workflow scenarios, and
  a simple Workflow, Task, and `seqlane run` explanation.
- Describe controlled agent sessions, turn gates, mechanical work outside the
  agent loop, and multi-agent workflows only where current source supports the
  claim.
- Add the minimum package scripts, dependency, configuration, and lockfile
  entries needed to build the site.
- Add a GitHub Pages workflow that builds the site and publishes the generated
  artifact with least-privilege permissions.
- Keep the public app and its content separate from canonical SDLC documents.

## Out of scope

- Migrating all Markdown documentation into the public app.
- A CLI reference, setup guide, API reference, blog, or additional site pages.
- Documenting commands other than the single `seqlane run` example.
- New workflow, runtime, or CLI behavior.
- Roadmap, unshipped capability, or internal Mastra implementation claims.
- Replacing or restructuring `docs/sdlc/`.

## Implementation plan

1. Establish the app directory, VitePress configuration, package scripts, and
   pinned dependency.
2. Write the single homepage from verified current workflow and CLI behavior.
3. Configure the repository base path and GitHub Pages artifact deployment.
4. Build the site locally and validate workflow syntax and SDLC indexes.
5. Reconcile nearby documentation and record the implementation outcome.

## Affected areas

- `apps/docs/`
- `pnpm-lock.yaml`
- `.github/workflows/` Pages workflow
- `docs/sdlc/tasks/index.md`

Keep internal SDLC source under `docs/sdlc/`; do not make the public site its
canonical location.

## Verification

- Run the public app build using the repository-pinned Node and pnpm versions.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run `actionlint` for the Pages workflow when available.
- Inspect the built output for the intended base path and the absence of
  unsupported commands or roadmap claims.
- Run the repository formatting and affected-project checks.

## Completion criteria

- A single public homepage builds reproducibly from the repository.
- The page explains workflows, tasks, and the `seqlane run` entry point in
  concise, current-behavior language.
- GitHub Pages can publish the build artifact with least-privilege permissions.
- Internal SDLC documents remain in `docs/sdlc/` and all documentation checks
  pass.
- The task outcome records exact verification and target-branch delivery state.

## Outcome

Implemented the `apps/docs` VitePress homepage and the GitHub Pages workflow.
The page uses current workflow, task, session, deterministic-work, and parallel
execution behavior only. It contains one conceptual CLI example.

Checks passed:

- `pnpm exec nx build docs-site`
- `pnpm docs:index`
- `pnpm docs:validate`
- `pnpm exec prettier --check` for the changed files
- `pnpm test:mapping`

`actionlint` was not installed locally. The repository CI runs it for workflow
changes.

## Delivery state

Implemented in the current worktree. The change is not yet committed, merged,
or reachable from the target branch, so it does not establish public-site
delivery.

## Traceability

- [prd.seqlane-on-mastra: Seqlane on Mastra](../prd/2026-09-03-seqlane-on-mastra.md)
- [SDLC documentation system](../specs/2026-09-03-sdlc-documentation-system.md)
