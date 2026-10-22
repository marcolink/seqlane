---
id: task.expand-public-documentation-navigation
title: Expand Public Documentation Navigation
status: completed
owners:
  - core
created: 2026-09-18
updated: 2026-10-22
upstream:
  - prd.seqlane-runtime
supersedes: []
---

# Expand Public Documentation Navigation

> Historical task record. Scope and outcomes describe work before the current migration.
> Current execution authority: [Effect v4 execution and operations](../specs/2026-10-21-effect-v4-execution-and-operations.md).
> Current-owner links record the later contract transfer. They do not establish historical Effect v4 use or current delivery.

## Objective

Add a compact public documentation hierarchy with a common sidebar. Explain
current workflow, task, session, and `seqlane run` behavior without publishing
internal SDLC content or unshipped claims.

## Upstream requirements

Use the current workflow and runtime behavior defined in
[prd.seqlane-runtime](../prd/2026-10-21-seqlane-runtime.md). This task
adds presentation and navigation only. It does not change product behavior.

## Scope

- Add a Run page as the only CLI-command page.
- Add a Run flag reference with one anchor per current flag.
- Add a public installation guide from the current package requirements.
- Add public authoring pages for workflows, task types, sessions, workspaces,
  and model selection.
- Add public adapter pages for configuration and runtime capabilities.
- Configure an Introduction-first VitePress sidebar and matching top navigation.

## Out of scope

- Publishing, moving, or linking the internal `docs/sdlc/` corpus.
- Documenting CLI commands other than `seqlane run`.
- New CLI, workflow, runtime, or GitHub Pages behavior.
- Roadmap or unshipped product claims.

## Implementation plan

1. Verify the current public workflow and CLI behavior in source.
2. Add concise public pages under `apps/docs/`.
3. Configure shared sidebar navigation with Introduction first.
4. Build the site and validate canonical SDLC metadata.

## Affected areas

- `apps/docs/.vitepress/`
- `apps/docs/introduction/`
- `apps/docs/authoring-workflows/`
- `apps/docs/adapters/`
- `apps/docs/cli/`
- `apps/docs/runtime-behavior/`
- `docs/sdlc/tasks/`

## Verification

- Build the VitePress app directly.
- Build the Nx `docs-site` target.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run Prettier for changed files.
- Inspect public copy against current CLI and workflow source.

## Completion criteria

- The site has a common sidebar with Introduction first.
- The site has an installation guide for global and project-local use.
- The Run page exposes each current flag in its right-side outline.
- Public copy describes only current behavior.
- `Run` is the only documented command.
- Internal SDLC content is not published through the public site.

## Outcome

Implemented the public documentation hierarchy and shared sidebar. The Run,
authoring, and runtime pages describe current source behavior only. Workflow
ideas were removed from the public site.

Added adapter pages for OpenCode, Codex, and ACP configuration and capabilities.
Added detailed pages for agent tasks and shell tasks.
Added a workspace scheduling diagram, related workflow example, and
parallel-execution guidance.

Added an Introduction section with What is Seqlane?, How it works, and Getting
started pages. The installation guide covers global and project-local use.
Added a Run flag reference with right-side anchor navigation.
Added one `seqlane run` example for each Run flag.

Checks passed:

- `pnpm --dir apps/docs exec vitepress build .`
- `NX_WORKSPACE_DATA_DIRECTORY="$PWD/.nx/workspace-data" NX_DAEMON=false pnpm exec nx build docs-site`
- `pnpm docs:index`
- `pnpm docs:validate`
- `pnpm exec prettier --check` for format-supported changed files
- `pnpm test:mapping`

## Historical delivery state

Implemented in the current worktree. The change is uncommitted and is not
reachable from the target branch, so it does not establish public-site
delivery.

## Traceability

- [prd.seqlane-runtime: Seqlane Runtime Product Requirements](../prd/2026-10-21-seqlane-runtime.md)
- [task.public-documentation-site: Publish a Minimal Public Documentation Site](./2026-09-18-public-documentation-site.md)
- [SDLC documentation system](../specs/2026-09-03-sdlc-documentation-system.md)
