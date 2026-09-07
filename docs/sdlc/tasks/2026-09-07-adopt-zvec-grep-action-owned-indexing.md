---
id: task.adopt-zvec-grep-action-owned-indexing
title: Adopt Action-Owned zvec-grep Indexing
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - spec.zvec-grep-action-owned-indexing
supersedes: []
---

# Adopt Action-Owned zvec-grep Indexing

## Objective

Move zvec-grep package resolution and project indexing into the workspace
Action so review workflow callers only start the Action for the reviewed
project.

## Upstream requirements

- Follow [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md).
- Preserve [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md).
- Do not modify the historical completed migration task.

## Scope

- Add pure zvec command construction and foreground index execution to
  `actions/zvec-grep-server`.
- Preserve existing process startup, readiness, cleanup, inputs, and outputs.
- Remove the standalone review-workflow indexing step and target `review-target`
  through the Action `working-directory`.
- Update Action README/metadata and committed bundles.
- Add this task/spec to generated SDLC indexes.

## Out of scope

- New workspace or consuming-workflow zvec-grep dependencies.
- Changes to unsafe-file policy, zvec-grep protocol, or service lifecycle
  semantics.
- Changes to historical tasks or accepted ADRs.

## Implementation plan

1. Add a focused failing unit test for exact resolve/index/server/readiness command
   construction, ordering data, and home/model-cache environment values.
2. Extract cohesive zvec command/policy helpers and implement foreground
   package resolution/index execution before detached service spawn.
3. Update the review workflow and caller-facing Action documentation/metadata.
4. Rebuild bundles and run focused tests, mappings, typechecks, YAML/actionlint,
   and SDLC validation.

## Affected areas

- `actions/zvec-grep-server/`
- `.github/workflows/seqlane-code-review.yml`
- `docs/sdlc/specs/2026-09-07-zvec-grep-action-owned-indexing.md`
- `docs/sdlc/tasks/2026-09-07-adopt-zvec-grep-action-owned-indexing.md`
- `docs/sdlc/specs/index.md`
- `docs/sdlc/tasks/index.md`

## Verification

- Record the required TDD red result before production changes.
- Run `pnpm exec vitest run src/...spec.ts` for the Action.
- Run Action typecheck/build/bundle-drift and `pnpm test:mapping`.
- Parse workflow and Action YAML; run `actionlint` when available.
- Run `pnpm docs:index` and `pnpm docs:validate`.
- Run formatting/diff checks relevant to changed files.

## Completion criteria

- The Action performs resolve/index/start/readiness in order and does not spawn
  a server when resolution or indexing fails.
- The explicit existing index policy and environment propagation are tested.
- Review workflow callers contain no zvec index command and target `review-target`.
- Action bundles are rebuilt with no drift.
- Verification results are recorded in this task's Outcome.

## Outcome

Implemented the Action-owned resolve/index/start/readiness lifecycle, preserved
the explicit file policy and environment propagation, removed the workflow
index step, and changed the zvec Action bundles to loadable CJS entrypoints.
Scoped Action tests, typecheck, bundle load/drift, YAML parsing, test mapping,
format, and SDLC validation passed. Full repository typecheck remains blocked
by unrelated pre-existing errors outside this task.

## Traceability

- [spec.zvec-grep-action-owned-indexing](../specs/2026-09-07-zvec-grep-action-owned-indexing.md)
- [adr.seqlane-action-library-boundary](../adrs/2026-09-06-seqlane-action-library-boundary.md)
