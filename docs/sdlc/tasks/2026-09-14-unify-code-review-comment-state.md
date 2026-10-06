---
id: task.unify-code-review-comment-state
title: Unify Code Review Comment State and Cost Projection
status: in-progress
owners:
  - core
created: 2026-09-14
updated: 2026-10-06
upstream:
  - spec.github-native-review-publication
  - spec.versioned-pull-request-review-comments
  - spec.incremental-pull-request-review-scope
  - spec.review-run-manifest-and-provenance
supersedes: []
---

# Unify Code Review Comment State and Cost Projection

## Objective

Make the hidden, versioned comment state the only source for the review
checkpoint, human report, and published-run cost.

## Upstream requirements

Implement `requirement-comment-authority`, `requirement-hidden-transport`,
`requirement-cost-projection`, `requirement-size-warning`, and
`requirement-comment-index` in
[spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md).

The active [versioned-comment contract](../specs/2026-09-05-versioned-pull-request-review-comments.md)
owns v5 state, retained findings, publication identity, and run status.
The active [incremental-scope contract](../specs/2026-09-13-incremental-pull-request-review-scope.md)
owns report classification, checkpoint selection, and generation-qualified IDs.
The active [manifest contract](../specs/2026-09-14-review-run-manifest-and-provenance.md)
owns evidence, location, verification, and manifest-reference schemas.
The publication draft supplies the linked hidden transport and cost fields.
It does not authorize a second v5 shape.

## Scope

- Define one strict v5 state schema for the scope checkpoint, findings,
  artifact references, publication identity, cost aggregate, and period start.
- Replace the collapsed machine-data section and visible JSON metrics ledger
  with one bounded base64/gzip HTML comment block.
- Implement the bounded canonical codec and streaming decoder from the spec.
- Render the visible report solely from validated state. Show known overall
  and last published run cost. Mark missing provider cost and new-period start.
- Define the typed publication operation in hidden state. Hash a deterministic
  digest-free render and verify the operation and exact body on readback.
- Redact secret-like values and encode untrusted text and links before
  rendering the projection or retaining bounded artifact data.
- Deduplicate GitHub run ID and attempt after recent-run compaction without
  dropping cumulative cost or incompleteness.
- Implement the specified warning and hard-limit behavior without moving the
  prior checkpoint or hiding compaction and omissions.
- Classify legacy states and malformed current states without silently
  migrating a visible ledger into the new cost period.
- Ignore state payloads from every older schema version. Each older version
  selects a full current-PR baseline, with a new generation and cost period.
- Add the typed authority index and resumable duplicate-reconciliation state.
- Implement the empty revision-0 baseline for initial creation and authorized
  legacy replacement.

## Out of scope

- Artifact transport and cleanup.
- Publication queue and GitHub write orchestration.
- Allocation of new finding IDs, cause admission, and changes to scope formulas.

## Documentation impact

Classification: contract-change

- PRD: no change.
- RFC: no change.
- SPEC: pin concrete v5 wire field names, bounded summaries, and transport markers.
- TASK: record the private admission slice and remaining delivery.
- ADR required: no.

### Rationale

PR #176 provides deterministic Git evidence but requires a trusted scope identity.
The current reader accepts v4 and returns no state for malformed input.
A separate v5 admission path must distinguish invalid state from absent state.
This work implements existing scope semantics and pins their private wire representation.
It does not change runtime APIs.

### Required work

1. Pin the shared v5 wire shape and transport in the owning specifications.
2. Record local admission delivery in this task and the incremental-scope task.
3. Update package documentation, regenerate indexes, and validate SDLC documents.

### Open questions

None blocks this implementation slice.

## Implementation plan

### Next PR: trusted v5 report admission

Suggested title: `feat(review): admit trusted v5 review checkpoints`.

Stack this implementation on `codex/review-scope-evidence`, PR #176.
The inspected head is `7ce908bda54593ff7cc86fb70325eae538f49d54`.
PR #176 is based on PR #112 at `6688815`.
Recheck both heads before implementation. Merge in order: #112, #176, then this PR.

#### First tracer bullet

Outcome: one trusted report with any older schema selects a full baseline
through a private caller of `collectReviewScopeEvidence`.
The caller never decodes the old payload or uses its checkpoint.

Path: complete trusted comment inventory -> version classifier -> legacy
replacement ScopeIdentity -> existing collector -> full current-PR evidence.

Risk: missing, malformed, ambiguous, or future state can become an accidental
baseline and send previously reviewed code through discovery again.

Evidence: a temporary Git repository contains an earlier reviewed hunk and a
later edit. Admission from each older schema includes both in the baseline.
The old payload is malformed and its checkpoint is unavailable.
Neither condition changes baseline scope. No old decoder or checkpoint fetch runs.
Retained findings are empty. Current and future versions block until their
strict admission paths exist.

Excluded: production host enforcement, model dispatch, finding allocation,
manifest upload, cost accumulation, rendering, indexes, queues, and comment writes.
The existing v4 workflow remains on its current reader and schemas.
The real-Git fixture provides local integration evidence, not production hard limits.

Conceptual before and after:

```ts
// Before: current v4 reader. Missing or invalid state returns undefined.
const previousState = parseReviewState(previousReport);

// After: private v5 admission, separate from the v4 caller.
const admitted = await admitReviewScope(
  { pullRequest: frozenPullRequest, history: completeTrustedHistory },
  { git: boundedGit, admittedAt, signal },
);
// admitted contains the validated classification, scope identity,
// retained findings, and collector evidence. Invalid input throws a typed error.
```

The version gate runs before state decoding. Every positive schema version
less than the current version is legacy. For v5, this includes all v1-v4 reports.
The old payload is neither decompressed nor parsed. Old findings, IDs, checkpoint,
metrics, cost, and artifact references never enter the new review.
Only the trusted comment ID and exact marker identity remain for replacement guards.
The collector uses the complete current `B...H` diff, with the existing content exclusions.
The new baseline creates a fresh generation and cost period when later finalization is wired.

```ts
// Version policy, after trusted marker and identity validation.
if (schemaVersion > 0 && schemaVersion < CURRENT_SCHEMA_VERSION) {
  return legacyReplacementIdentity(reportId, markerDigest);
  // No legacy payload decoder. Admission selects full B...H evidence.
}
// Current version: strict decode. Future version: fail closed.
```

#### Additional slices in this PR

1. Establish complete, bounded, read-only authority lookup. Zero matching bot
   reports permits `absent`. Exactly one permits classification. Duplicate
   reports, truncated bodies, incomplete inventory, and lookup errors block
   admission. Reuse existing GitHub read ports where they preserve this evidence.
   Do not use latest-comment selection as proof of uniqueness.
   Require two matching inventories, each bounded to two pages and 200 comments.
   Stop on any mismatch with `REVIEW_AUTHORITY_UNSTABLE`; do not retry.
2. Implement the full strict v5 state and its shared component schemas.
   Include ScopeCheckpoint, RetainedFinding, FindingEvidence, LocationStatus,
   VerificationEvidence, RunStatus, ManifestReference, PublicationOperation,
   consumed source identities, manifest summary, and published cost fields.
   Reuse one schema per contract. Export shared schemas through the existing
   private workflow contracts package, preserving the Action-to-workflow
   dependency direction. Do not introduce a generic support package.
3. Add the canonical hidden transport and streaming decoder. Enforce limits
   before allocation: 20,000 encoded characters, 15,000 compressed bytes,
   and 512,000 decoded bytes. Require canonical base64, bounded gzip, fatal
   UTF-8 decoding, strict JSON validation, and one matching marker and block.
   Prove the encoder and decoder round trip without a GitHub write.
4. Implement one discriminated classifier with `absent`, `legacy`, `current`,
   and `invalid-current` outcomes. Every older positive version supplies only
   its trusted comment and marker identity for a full baseline replacement.
   If that identity is unambiguous, malformed legacy payloads remain replaceable.
   Never decode or import legacy state. Unsupported current transport and
   future schema versions fail closed.
5. Bind current state to the repository, PR, generation, published status,
   reviewed revision, source run, operation, and manifest reference.
   Retain the exact comment identity and canonical state digest in admission
   context for later publication guards. Keep the captured legacy marker digest.
   Reject duplicate or foreign IDs, invalid next indexes, and contradictory
   bindings. Missing or malformed references invalidate current state.
   Artifact expiry alone preserves a structurally valid checkpoint.
   This reader does not claim artifact availability or reusable coverage.
6. Connect the classifier to one private admission entry point. Only absent
   and legacy select baseline variants. Current state selects C from
   `reviewedRevision`. Timestamps, metrics, and previousReviewedRevision do not.
   Reuse the collector for exact commit validation, checkpoint fetch, HEAD
   validation, path selection, exclusions, and shared Git budgets.
   Keep the frozen identity consistent with evidence through empty scope.

The second tracer uses one valid serialized v5 report in the same real-Git
fixture. Only the later edit enters `batches`. Current-PR evidence remains in
`validationBatches`, and all retained findings preserve their IDs and prior evidence.
Malformed v5 stops before Git collection. Broader schema and codec cases follow
only after this integration path passes.

#### Implementation checks

No user decision blocks implementation. Two technical checks precede the second tracer.
The GitHub read seam must prove inventory completeness and report uniqueness.
If the current port cannot provide that evidence, add a narrow read-only port.
The full v5 wire shape must share one schema across state and manifest consumers.
Freeze field names and cross-field bindings in the shared schema before codec work.
Any conflict with active specifications requires a documentation impact reassessment.

The same-head tracer returns empty review and validation batches with no patch
command. This PR makes zero model calls because admission is deterministic.
Dispatch rules for empty scope and targeted cause verification remain later work.
No admission result advances a checkpoint or allocates a generation or finding ID.

#### Test gates

- Real Git: serialized current state -> checkpoint scope -> collector output.
  Cover a non-ancestor checkpoint, same-head input, and an excluded-only change.
- Migration: absent report, every older version, malformed legacy payload
  with a valid marker, and a v4 progress notice beside completed state.
  Assert complete `B...H` review input and zero retained legacy findings.
  Include old checkpoints that are missing Git objects and legacy payloads
  that exceed decoder limits within the trusted comment bound.
  Assert no legacy decoding or checkpoint fetch.
  Assert no legacy IDs, metrics, cost, or artifact references enter admission.
- Rejection: malformed v5, future version, duplicate markers or bot reports,
  unknown fields, truncated inventory, mismatched identities, and missing reference.
  Assert no Git, model, artifact, or comment-write work after rejection.
- Bounds: exact codec and UTF-8 byte limits, one byte over, invalid base64,
  malformed gzip, decompression expansion, invalid UTF-8, and invalid JSON.
- State: generation-qualified ID isolation, duplicate IDs, next-index bounds,
  evidence shapes, operation bindings, published status, and retained evidence.
- Compatibility: existing v4 reader, ledger, lifecycle, and publication suites
  retain their observable behavior. New named exports do not replace v4 schemas.

Run `pnpm run test:mapping` before tests. Run focused codec, classifier, admission,
schema, and real-Git suites, then both affected private-package suites.
Run source typecheck, `pnpm run typecheck:specs`, scoped lint, formatting,
`pnpm docs:index`, `pnpm docs:validate`, and `git diff --check`.
Compare inherited typecheck errors with the exact stack base. Do not waive new errors.

When every classification reaches its specified outcome through the private
entry point, the next PR is complete. Evidence must be complete, with no external writes.
Hosted v5 delivery remains pending until production host and workflow wiring land.

### Later slices

1. Assemble the revision-0 empty baseline and completed candidate through the
   shared v5 schemas and codec. Integrate the validated authority lookup with
   the producer. Allocate the generation only for a new baseline candidate.
2. Move mechanically derived cost into the state aggregate. Keep detailed
   metrics available to the artifact task without rendering their JSON.
3. Render the projection and hidden block from one state value. Reserve
   warning space before measuring and enforce both hard caps.
4. Add bounded authority-index lookup and duplicate reconciliation. Update
   migration, docs, and focused compatibility tests.

## Affected areas

- `workflows/code-review/contracts.ts`: new named v5 exports, with v4 exports intact.
- Cohesive v5 state, finding, evidence, reference, and operation schema modules
  in `workflows/code-review/`, shared by future report and manifest consumers.
- New codec, classifier, and scope-admission modules in `libs/action-code-review/src/`.
- `libs/action-code-review/src/github-port.ts`: complete authority read seam,
  only where the existing read contract is insufficient.
- `libs/action-code-review/src/review-history.ts`: v4 compatibility boundary.
- `libs/action-code-review/src/review-scope-contracts.ts` and
  `review-scope-evidence.ts`: existing scope and Git contracts to reuse.
- Colocated schema, codec, classifier, and admission tests. Cross-module
  integration tests declare valid `@test-scope` implementation paths.
- `libs/action-code-review/src/index.ts`: intentional private admission exports.

Later slices also affect:

- `libs/action-code-review/src/publication-state.ts`
- `libs/action-code-review/src/publication-rendering.ts`
- `libs/action-code-review/src/publication-fitting.ts`
- `libs/action-code-review/README.md`

## Verification

- Run test mapping and focused codec, migration, projection, cost, malformed
  input, operation-digest, hostile Markdown/HTML/URL, and size-bound tests.
  Cover the exact boundaries and lookup states required by the specification.
- Verify multibyte comment size and a missing-cost run. Run docs validation
  and `git diff --check`.

## Completion criteria

- The next run restores one strict hidden state. Visible text cannot alter it.
- Cost and size behavior match every upstream acceptance criterion.
- No visible per-run JSON metrics ledger remains in v5 publication.

## Outcome

The private reader/admission slice is implemented locally on top of PR #176
at `7ce908b`. It reads a complete bounded issue-comment inventory, classifies
trusted reports, validates shared v5 state, and calls the existing collector.
Every v1–v4 payload is ignored and selects a full current-PR baseline.
Malformed v5, future versions, and ambiguous authority block before Git work.
PR #178 adds two bounded inventory scans to detect pagination movement and
report changes. Tests cover deletion across page boundaries, changed report
content, identity, author, timestamp, and incomplete or malformed second scans.
The shared report marker now lives in a pure identity module, so the codec
does not depend on GitHub authority lookup. The scans provide a consistency
check; publication guards remain necessary for changes after the read.

Real-Git integration covers full legacy replacement, incremental changes,
older hunks in an edited file, non-ancestor checkpoints, same-head input,
and excluded-only scope. Codec and schema tests cover byte bounds, malformed
input, identity and evidence digests, and retained findings.

Local verification passes test mapping, the Action library and entrypoint
suites, source typecheck, scoped lint, formatting, and SDLC validation.
Test typechecking retains three errors in the unchanged
`pr-code-review-example.spec.ts` at lines 1467 and 1532.
The quality scan flags normalized token overlap between the standard SHA-256
helper, an unrelated path helper, and the runtime's truncated trace-ID hash.
These contracts remain separate. The declarative state fixture exceeds the
function-size review threshold; its single concern is constructing valid state.

The production v4 workflow remains on its existing reader. Generation
allocation, model dispatch, manifest production, cost accumulation, rendering,
publication guards, and authority indexes remain pending. This task stays in progress.

## Delivery state

Partial local implementation. No target-branch delivery claim is made here.

## Traceability

- Contract: [spec.github-native-review-publication](../specs/2026-09-14-github-native-review-publication.md)
- State: [spec.versioned-pull-request-review-comments](../specs/2026-09-05-versioned-pull-request-review-comments.md#requirement-state-contract)
- Classification and checkpoint: [spec.incremental-pull-request-review-scope](../specs/2026-09-13-incremental-pull-request-review-scope.md#requirement-scope-selection)
- Evidence and reference: [spec.review-run-manifest-and-provenance](../specs/2026-09-14-review-run-manifest-and-provenance.md#requirement-finding-evidence)
- Collector dependency: [task.incremental-pull-request-review-scope](./2026-09-13-incremental-pull-request-review-scope.md)
- Stack base: [PR #176](https://github.com/marcolink/seqlane/pull/176)
- Reader/admission implementation: [PR #178](https://github.com/marcolink/seqlane/pull/178)
- Follow-on proposal: [PR #112](https://github.com/marcolink/seqlane/pull/112)
