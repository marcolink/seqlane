---
id: task.session-fork-naming
title: Rename Session Branching to Session Forking
status: in-progress
owners:
  - core
created: 2026-10-05
updated: 2026-10-05
upstream:
  - spec.session-checkpoint-reuse-and-branching
  - spec.model-selection-and-session-model-semantics
  - spec.mastra-backed-seqlane-workflows
supersedes: []
---

# Rename Session Branching to Session Forking

## Objective

Deliver [issue #173](https://github.com/marcolink/seqlane/issues/173): authors use
`fork(checkpoint, model?)` for a separate session and conditional choice for
workflow control flow. Preserve execution behavior.

## Upstream requirements

The session spec owns checkpoint provenance, isolation, admission, and native
fork requirements. The model spec owns inheritance and optional model selection.
The Mastra workflow spec owns execution integration and private engine boundaries.
Update those contracts before implementation; this task does not override them.

## Documentation impact

Classification: contract change.

- BRD: no change; business scope is unchanged.
- PRD: update session terminology in `prd.seqlane-on-mastra`; preserve requirements.
- RFC: clarify current session terminology in
  `rfc.mastra-runtime-and-operational-foundation`; preserve architectural decisions.
- SPEC: update the three upstream specs, including compatibility and selected-only
  materialization. Audit other active specs for session-specific references.
- TASK: create `task.session-fork-naming`; preserve completed historical tasks.
- ADR required: no. Naming changes do not alter session architecture. Preserve
  accepted ADRs, stable metadata IDs, and existing canonical paths.

### Rationale

`dsl.ts`, authoring contracts, and Plan schemas still use `branch`. Runtime
session policies use that discriminant, but executor sessions already expose
native `fork`. Control-flow `.branch()` references require contextual review.

### Required work

First document the compatibility decision in the owning session spec. Then align
model and workflow specs, upstream terminology, implementation, and public docs.
Regenerate indexes after document edits. Avoid moving files solely for naming.

### Open questions

No blocking ownership questions. The user approved the compatibility decision
below; record it in the active spec before changing code.

## Scope

Introduce preferred session helpers and policy discriminants; preserve deprecated
API compatibility. Rename current inferred types, diagnostics,
session-specific identifiers, fixtures, tests, examples, and current documentation.
Keep the existing checkpoint, model, cancellation, and failure behavior.

## Out of scope

Conditional-choice API changes, Mastra native control-flow `.branch()` renames,
session merging, adapter capability changes, checkpoint format changes, and
rewriting accepted ADRs or completed task history.

## Implementation plan

### Compatibility decision

Current documentation must call the session operation a fork. Use `fork` in all
session prose, headings, API examples, and session-policy examples. Do not describe
sessions as branches or show the deprecated helper in public guides. Reserve
branching terminology for conditional control flow. Preserve accepted ADR and
completed-task history, stable IDs, and existing link targets.

The API transition must remain compatible. Add `fork(checkpoint, model?)` and
retain exported `branch(checkpoint, model?)` with a JSDoc `@deprecated` annotation
that points to `fork`. Existing imports, signatures, model selection, and behavior
continue to work. Preserve the legacy helper's returned `type: "branch"` shape
for callers that inspect it; the new helper returns `type: "fork"`.

Accept both authoring policy shapes and existing serialized `type: "branch"`
Plans. Normalize legacy policies to `type: "fork"` at the canonical validated
Plan boundary before runtime consumption. New canonical Plans serialize `fork`;
legacy Plans execute with identical semantics. Reuse owning Zod schemas and one
normalizer. Check consumers for reliance on unnormalized policy shapes.

Document only the preferred `fork` import/call and Plan spelling in public guides.
Keep legacy names in API deprecation annotations and compatibility tests; this
implementation plan records them to define the compatibility contract. Existing
API callers need no migration. Do not remove compatibility
in this task or invent a removal deadline. Never globally replace control-flow
branches.

### Tracer bullet: one fork from authoring through execution

- Outcome: a source completes; `fork(source.session)` creates a separate session
  from its terminal checkpoint and executes a consumer.
- Path: public helper/export -> builder -> canonical Plan schema -> runtime
  validation/preflight -> checkpoint publication -> native executor fork.
- Risk: a hidden `"branch"` check rejects the new Plan or changes session behavior.
- Evidence: export/type assertions, serialized Plan round-trip, legacy-helper and legacy-Plan
  compatibility, and runtime integration assertions for checkpoint and distinct session.
- Excluded: model overrides, nested choices, migration examples, and terminology polish.

1. Update owning specs with the new helper, discriminant, and compatibility policy.
2. Add `fork` in `libs/core/src/dsl.ts` and deprecate the retained `branch` helper.
   Update `contracts.ts`, `plan-types.ts`, canonical normalization, builder consumers,
   and public-export assertions in `index.spec.ts`. Test both helper signatures,
   legacy return shape, and equivalent execution from both Plan spellings.
3. Follow the policy through runtime validation, session preflight, ordering, and
   resolution. Rename `UnsupportedSessionBranchError` to
   `UnsupportedSessionForkError`, including imports, diagnostics, and assertions.
4. Adapt one existing runtime regression to execute the new serialized policy.
   Prove the captured source checkpoint and separate child session; gate expansion
   on passing core and runtime focused checks.

### Slice: model inheritance and continuation

Update model preflight, model-selection fixtures, and standalone profile identifiers.
Prove inherited selection, explicit override before the first prompt, pinned
selection, and `reuse` continuing the same session. Preserve unsupported native-fork
rejection before session resolution. Keep adapter operation contracts unchanged.

### Slice: choice selection and lifecycle

Trace choice consumer registration to checkpoint publication. Adapt existing choice
regressions: only the selected arm materializes its fork; the unselected arm makes
zero session calls. Cover a checkpoint source before a choice and a source inside
the selected arm. Preserve source-before-continuation checkpoint capture, independent
fork ordering, cancellation, failure poisoning, and causal dependent failures.
Do not expand this rename into a lifecycle redesign; record any pre-existing defect.

### Slice: public migration and completion

Update `workflows/all-features-example`, `workflows/git-diff-summary-example`, their
READMEs, and public session-authoring pages. Include a readable workflow with
`session: ({ tasks }) => fork(tasks.source.session)` alongside
`.when(...).task(...).otherwise(...)`. Explain reuse versus fork and the preferred
import/Plan spelling. Public session guides show only `fork`; the compatibility
helper remains discoverable through its API deprecation annotation. Review residual
`branch` matches individually. Update active SDLC terminology, indexes, and
delivery evidence after implementation.

## Affected areas

- Core: `dsl.ts`, `contracts.ts`, `plan-types.ts`, builder and export/schema tests.
- Runtime: `runtime/validation/plan-validation.ts`, `runtime/session/`,
  `runtime/execution/model-preflight.ts`, model tests, choice compilation consumers,
  `runner/profile/standalone-profile.ts`, and runner Plan snapshot tests.
- Fixtures: `libs/fixtures/src/model-selection-workflow.ts` and its tests.
- Consumers: workflow examples, public docs, and session-specific active contracts.

## Verification

Run `pnpm test:mapping` before tests. Run focused core, runtime session, model,
choice, fixture, and Plan snapshot tests after each slice. Tests must prove behavior,
not merely assert renamed strings.

Final gates: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm build`,
`pnpm format:check`, `pnpm docs:index`, `pnpm docs:validate`, public docs build,
and `git diff --check`. Use Node 24 or newer. Check public types for Mastra leaks
and forbidden `/ee/` imports if integration files change. Run Ripwire change and
quality checks before declaring implementation ready. Confirm residual `branch`
uses describe control flow, Git, historical records, or compatibility in API
annotations, tests, and implementation contracts. Fail the documentation audit if
current public session guides contain `branch(...)`, `type: "branch"`, or session
branching prose. Review `fork` matches to ensure session-fork descriptions do not
rename conditional control flow.

## Completion criteria

- Preferred public session API and canonical serialized policies use `fork`.
- `branch` remains exported, deprecated, and compatible in signature and return shape.
- Legacy authoring policies and serialized Plans remain accepted and execute identically.
- Current public session documentation uses only `fork`, including all examples.
- Deprecated `branch` appears only in API annotations, compatibility contracts/tests,
  or preserved history; conditional control-flow terminology remains distinct.
- Checkpoint provenance, isolation, selection, ordering, and failure behavior pass.
- Unselected choice arms create no sessions or checkpoints.
- Examples distinguish session reuse, session forking, and conditional choice.
- Engine and adapter types remain behind existing private boundaries.
- Required validation passes; delivery evidence identifies the merged target revision.

## Outcome

Implemented locally in [PR #174](https://github.com/marcolink/seqlane/pull/174).
The public `fork` helper emits the new policy. Deprecated `branch` preserves its
signature and legacy return shape. The builder and Plan schema normalize both
spellings to canonical fork policies, including repeat attempts.
Protocol readers accept old and new session snapshots; new snapshots use fork.

Updated session diagnostics, fixtures, examples, READMEs, public guides, and active
contracts. Public session guides contain no deprecated helper or policy examples.
Accepted ADRs and stable metadata IDs remain unchanged.

Verification passed: repository tests (including a rerun outside the sandbox for
process-lifecycle tests), production TypeScript build, repository build, lint,
formatting, test mappings, SDLC validation/tests, and public docs build. Additional
regressions cover legacy Plan model overrides,
malformed policies, and helper return types/shapes.

The complete spec typecheck still reports three errors in unchanged
`libs/action-code-review/src/pr-code-review-example.spec.ts` at lines 1467 and 1532.
Keep this task in progress until that merge gate is resolved. Ripwire confirms the
legacy helper's argument contract is unchanged. Its structural report retains
recent-churn warnings on touched session code and a minor diagnostic
complexity increase; these do not replace the passing execution regressions.

## Delivery state

Implementation is based on `origin/main` in PR #174, not delivered on `main`.
PR #170 has landed on main and is inherited by this PR. Rebase integration preserves
its selected-arm session behavior with canonical fork policies. The choice example
and additional acceptance criteria above remain pending. Resolve the outstanding
spec typecheck gate and verify the final remote head before recording delivery.

## Traceability

- [PR #174](https://github.com/marcolink/seqlane/pull/174)
- [PR #170](https://github.com/marcolink/seqlane/pull/170)
- [Issue #173](https://github.com/marcolink/seqlane/issues/173)
- [spec.session-checkpoint-reuse-and-branching](../specs/2026-09-02-session-checkpoint-reuse-and-branching.md)
- [spec.model-selection-and-session-model-semantics](../specs/2026-09-03-model-selection-and-session-model-semantics.md)
- [spec.mastra-backed-seqlane-workflows](../specs/2026-09-08-mastra-backed-seqlane-workflows.md)
