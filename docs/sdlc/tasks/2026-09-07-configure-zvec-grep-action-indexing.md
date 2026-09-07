---
id: task.configure-zvec-grep-action-indexing
title: Configure zvec-grep Action Indexing
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - spec.zvec-grep-action-owned-indexing
supersedes: []
---

# Configure zvec-grep Action Indexing

## Objective

Expose safe zvec-grep indexing options through the Action while preserving its
owned resolve, index, server, and readiness lifecycle.

## Upstream requirements

Implement [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md).

## Scope

- Add `embedding`, `max-filesize`, and newline-delimited `glob` inputs.
- Replace the path-valued `model-cache` input with a boolean cache toggle.
- Preserve built-in allowlist ordering and apply immutable exclusions last.
- Update command tests, Action metadata, README, bundles, and SDLC indexes.

## Out of scope

- Workflow changes or zvec-grep package changes.
- Changes to process lifecycle, readiness, outputs, or security exclusions.
- A caller-provided model cache directory input.

## Implementation plan

1. Add failing command and environment tests for defaults, overrides, glob
   ordering, immutable exclusions, and cache true/false behavior.
2. Extend command construction and Action input parsing with toolkit boolean
   parsing.
3. Update public metadata/docs and rebuild the loadable ESM entrypoint bundles
   with their CommonJS bridge.
4. Run focused tests, typecheck, bundle/load/drift checks, mappings, YAML, and
   SDLC validation.

## Affected areas

- `actions/zvec-grep-server/`
- `docs/sdlc/specs/2026-09-07-zvec-grep-action-owned-indexing.md`
- `docs/sdlc/specs/index.md`
- `docs/sdlc/tasks/index.md`

## Verification

- Record the required TDD red result before production changes.
- Run focused Action tests, typecheck, build/load, and bundle-drift checks.
- Run test mapping, YAML parsing, `git diff --check`, and SDLC index/validation.

## Completion criteria

- Fixed direct mode, defaults, and all optional input overrides are passed as
  argument arrays.
- Additional globs appear after the built-in allowlist and before immutable
  exclusions.
- Model-cache true supplies the runner-temp path and false omits the variable.
- ESM bundles load and have no drift.
- Public documentation and SDLC traceability are current.

## Outcome

Implemented optional embedding, max-filesize, and additive glob inputs;
preserved fixed direct mode and immutable exclusions; and replaced the
path-valued model-cache input with toolkit-validated boolean behavior. Updated
the Action documentation, loadable ESM bundles with their CommonJS bridge,
tests, and SDLC indexes. Focused tests,
typecheck, bundle load/drift, and SDLC validation passed. Nx target execution
was unavailable because this restricted worktree cannot write the shared Nx
workspace-data lock.

## Traceability

- Contract: [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
- Prior delivery: [task.adopt-zvec-grep-action-owned-indexing](./2026-09-07-adopt-zvec-grep-action-owned-indexing.md)
