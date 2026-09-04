---
id: task.bounded-pr-code-review-evidence
title: Add Bounded Patch Evidence to Pull Request Reviews
status: completed
owners:
  - core
created: 2026-09-04
updated: 2026-09-04
upstream: []
supersedes: []
---

# Add Bounded Patch Evidence to Pull Request Reviews

## Objective

Reduce pull-request review latency by giving each review task bounded patch
evidence from the requested base-to-head revision range before it performs
targeted file inspection.

## Upstream requirements

No upstream SDLC document owns this example-specific optimization. Preserve the
existing review contract, explicit revision identity, read-only execution
policy, and specialist fan-out topology.

## Scope

- Extend the deterministic Git review evidence produced by
  `examples/pr-code-review.ts` with a bounded patch from the explicit
  `baseRevision...headRevision` range.
- Include explicit overflow metadata so truncated patch evidence cannot be
  mistaken for a complete diff.
- Make inspection and specialist review prompts treat the supplied patch as
  the primary evidence source, using targeted reads only when the bounded
  patch is insufficient or truncated.
- Add tests for complete and oversized patch evidence, patch truncation
  metadata, and patch-first prompt guidance.
- Update `examples/README.md` to document bounded patch evidence and the
  patch-first review behavior.

## Out of scope

- Changing the selected models or reasoning levels.
- Changing the inspection, specialist-lane, or synthesis topology.
- Caching or replacing `pnpm/action-setup`.
- Changing GitHub Actions setup, review verdict semantics, or published report
  fields.
- Removing targeted workspace inspection or permitting command execution in
  review tasks.

## Implementation plan

1. Add a bounded patch field and truncation metadata to the Git evidence
   schema, and collect it with the existing deterministic Git evidence task.
2. Preserve the exact revision range and retain existing changed-file,
   diff-stat, and whitespace-check evidence. Bound the retained model-facing
   patch after Git writes a run-scoped temporary file; the temporary file may
   be larger than the evidence bound and must be removed after collection.
3. Add patch-first instructions to inspection and specialist prompts while
   retaining the existing evidence, security, and read-only constraints.
4. Extend the example contract tests for normal output, overflow behavior, and
   prompt contents; keep the existing model and dependency assertions intact.
5. Update the examples README with the new evidence behavior and verify the
   documentation and example tests.

## Affected areas

- `examples/pr-code-review.ts`
- `apps/seqlane-cli/src/pr-code-review-example.spec.ts`
- `examples/README.md`

## Verification

- Run the focused pull-request code-review example tests.
- Run `pnpm docs:index`.
- Run `pnpm docs:validate`.
- Confirm the existing model selections and specialist dependency topology
  remain unchanged.

## Completion criteria

- Every review task receives bounded patch evidence for the requested revision
  range, or explicit metadata that the retained evidence was truncated. The
  temporary full-diff artifact is documented as a transient implementation
  tradeoff, not as part of the bounded model input.
- Inspection and specialist prompts prioritize the supplied patch and do not
  claim a complete diff when truncation metadata is present.
- Tests cover complete and truncated patch evidence and patch-first guidance.
- The examples README documents the behavior.
- Existing review models, reasoning levels, topology, identity fields, and
  read-only execution constraints remain unchanged.
- Focused tests and both SDLC documentation checks pass.

## Outcome

The deterministic review evidence task writes the exact Git patch to a
run-scoped temporary file, then reads only a 48,000-byte UTF-8 and
newline-aware model-facing prefix and records the original byte length and
truncation state. When no original newline fits within the retained prefix, no
partial logical line is retained before the truncation marker. Because the
current direct-argv task context has no bounded file-output primitive, Git may
transiently write a larger patch before the prefix is retained; cleanup removes
that artifact after collection. Inspection and specialist prompts review the
retained patch first while retaining targeted, read-only workspace inspection
for missing context. Focused example tests cover direct argv, complete patch
output, overflow metadata, UTF-8 boundaries, oversized first lines,
rename/binary metadata, and patch-first guidance.

## Traceability

This task is intentionally implementation-only and has no upstream SDLC
document. Its affected-area references identify the canonical example,
contract tests, and reader documentation that must remain aligned.
