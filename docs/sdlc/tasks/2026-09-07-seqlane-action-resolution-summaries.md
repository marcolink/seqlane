---
id: task.seqlane-action-resolution-summaries
title: Publish Human-Readable Merge Resolution Summaries
status: completed
owners:
  - core
created: 2026-09-07
updated: 2026-09-07
upstream:
  - spec.seqlane-action-merge-conflict-resolution
supersedes: []
---

# Publish Human-Readable Merge Resolution Summaries

## Objective

Publish bounded, human-readable GitHub Action summaries for merge-conflict
resolution attempts while keeping raw executor events and file contents out of
normal logs and summaries.

## Upstream requirements

Implement `requirement-observability-and-secrets` from
[spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md).

## Scope

- Export and reuse the canonical runtime workflow output schema and type.
- Return validated model summaries and file decisions from the agent runner.
- Capture rebase conflict commit identity mechanically from `REBASE_HEAD`.
- Aggregate one report per conflict attempt in the controller.
- Render rebase commit sections, one merge section, escaped Markdown, and a
  concise diagnostics digest.
- Preserve existing Action inputs and outputs.
- Add contract, controller, formatting, malformed-output, and regression tests.
- Rebuild and verify the committed Action bundle.

## Out of scope

- New Action inputs or outputs.
- Changes to conflict resolution policy, prompts, or push behavior.
- Raw event persistence, external observability, or full file-content display.

## Implementation plan

1. Add RED tests for reports, escaping, diagnostics, and validated output.
2. Export the runtime output schema and propagate validated runner output.
3. Capture Git rebase identity through the Git port.
4. Aggregate controller attempt reports without changing public result outputs.
5. Render bounded summaries and replace raw recording output with a digest.
6. Run focused tests, typechecks, bundle verification, and SDLC checks.

## Affected areas

- `libs/seqlane-runtime/src/workflows/resolve-merge-conflicts.ts`
- `libs/action-merge-conflict-resolution/src/`
- `actions/resolve-merge-conflicts/src/main.ts`
- `actions/resolve-merge-conflicts/dist/main.js`
- `docs/sdlc/specs/2026-09-06-seqlane-action-merge-conflict-resolution.md`

## Verification

- Focused resolver tests and test mapping.
- Resolver and Action typechecks.
- Action bundle rebuild and no-drift check.
- `pnpm format:check`, `git diff --check`.
- `pnpm docs:index`, `pnpm docs:validate`.

## Completion criteria

- Every rebase attempt has a human-readable commit section when identity is
  available.
- Merge resolution has one human-readable section.
- Model output is schema-validated and malformed output fails safely.
- Markdown, diagnostics, and secrets are bounded and safe.
- Existing Action inputs and outputs remain unchanged.
- Focused checks and bundle verification pass.

## Outcome

Completed. The runtime workflow now exports its canonical output schema and
type. The runner validates and returns model summaries and file decisions.
The controller aggregates bounded reports across conflict attempts. Rebase
reports capture `REBASE_HEAD` identity. They do not guess rewritten SHAs
because rebase continuation can advance through later commits. Merge reports
render one merge section.
Markdown values are escaped and bounded, while recording output is a
diagnostics count/truncation digest with no raw event payloads.

Existing Action inputs and outputs remain unchanged. The committed Action
bundle was rebuilt and the local entrypoint smoke test passed.

Verification passed for the focused resolver suite (82 tests), test mapping,
workflow helper tests, runtime and Action typechecks, stable bundle rebuild,
formatting, `git diff --check`, `pnpm docs:index`, and `pnpm docs:validate`.

The Nx wrapper targets could not write their cache under the read-only
canonical checkout from this worktree. Equivalent direct TypeScript, Vitest,
esbuild, and smoke commands passed.

## Traceability

- [spec.seqlane-action-merge-conflict-resolution](../specs/2026-09-06-seqlane-action-merge-conflict-resolution.md)
- [Action entrypoint and bundle task](./2026-09-06-seqlane-action-entrypoint-and-bundle.md)
