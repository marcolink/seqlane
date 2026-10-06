---
id: task.session-fork-naming
title: Use Session Fork Naming
status: in-progress
owners:
  - core
created: 2026-10-05
updated: 2026-10-06
upstream:
  - spec.session-checkpoint-reuse-and-branching
  - spec.model-selection-and-session-model-semantics
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Use Session Fork Naming

## Objective

Deliver [issue #173](https://github.com/marcolink/seqlane/issues/173). Authors use
`fork(checkpoint, model?)` to create a separate session. Conditional choice remains
workflow control flow. Preserve valid session execution behavior.

The user approved a breaking rename on 2026-10-06. Remove the previous helper,
policy spelling, schema transformations, compatibility aliases, and extra parsed
Plan types. Authoring and execution use one Plan contract.

## Upstream requirements

- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md): session checkpoint, reuse, fork, and ordering contracts.
- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md): model inheritance and fork overrides.
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md): private runtime ownership and session failure behavior.

## Scope

Use `fork` for the public helper, policy discriminant, session diagnostics,
fixtures, examples, public documentation, and protocol snapshots. Keep Git and
control-flow terminology unchanged. Preserve accepted ADRs and stable document
IDs and paths.

## Out of scope

Choice correctness fixes, performance work, unrelated type refactors, Git terminology,
Mastra control-flow APIs, accepted ADRs, and stable document IDs.

## Implementation plan

1. Export only `fork(checkpoint, model?)` for separate sessions.
2. Use `isolated`, `reuse`, and `fork` in the owning policy schemas and types.
3. Remove schema spelling transformations and compatibility-specific Plan types.
4. Update session consumers, snapshots, fixtures, and examples to use fork.
5. Keep fork policy/export, serialization, and existing session behavior regressions.
6. Update nearby documentation and active contracts, then validate and publish.

## Affected areas

Core DSL and Plan schemas, protocol snapshots, runtime session consumers,
fixtures/examples, public guides, and the owning session specification.

## Verification

Run repository test mappings/tests, typecheck, builds, lint, formatting, SDLC
indexes/validation, and the public documentation build.

## Completion criteria

- The package exports `fork`; no previous session-fork helper remains.
- Authoring, Plans, and session snapshots accept only the fork spelling.
- Helper arguments preserve the source checkpoint and optional model selection.
- Runtime checkpoint capture, model inheritance/overrides, and independent sessions remain valid.
- Public session guides and examples use fork terminology.
- Required tests, types, builds, lint, formatting, mapping, and docs checks run.

## Outcome

Implementation is on [PR #174](https://github.com/marcolink/seqlane/pull/174).
The current scope is the breaking fork-only API. Compatibility code and the
input/canonical Plan split are removed. Core and protocol regressions reject the
removed spelling; runtime tests exercise only supported session policies.

The PR contains no choice validation, event-reporting, ordering, or compiler
behavior changes beyond the session name. Public examples,
fixtures, session diagnostics, READMEs, and active contracts use fork terminology.
Historical ADRs, metadata IDs, and document paths remain unchanged.

The rename-only diff passed repository tests for 20 projects, builds/lint for
23 projects, formatting, test mappings, SDLC validation, and the public docs build.
Production compilation passed. Three spec typecheck errors in unchanged
code-review tests at lines 1467 and 1532 remain. The source diff audit confirms
all 14 changed production files contain only session-name substitutions.

## Delivery state

PR #174 is based on `origin/main`, which includes merged #170. This PR's changes
are not yet delivered on main. The conditional-choice documentation example from
#173 remains pending; it is outside the approved review-fix scope.

## Traceability

- [PR #174](https://github.com/marcolink/seqlane/pull/174)
- [Issue #173](https://github.com/marcolink/seqlane/issues/173)
- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)
- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
