import {
  reviewFindingIdPartsSchema,
  type ReviewMetadataV5,
  type ReviewStateV5,
  type RetainedFinding,
} from "@seqlane/code-review-workflow/contracts";
import { canonicalReviewJson, reviewSha256 } from "./review-state-canonical.js";
import { ReviewScopeError } from "./review-scope-errors.js";

function requireBinding(matches: boolean, message: string): void {
  if (!matches)
    throw new ReviewScopeError("REVIEW_STATE_BINDING_INVALID", message);
}

function validateFindingIdentityDigests(finding: RetainedFinding): void {
  requireBinding(
    finding.identityKey === reviewSha256(canonicalReviewJson(finding.identity)),
    "Finding identity digest is invalid.",
  );
  requireBinding(
    finding.occurrenceKey ===
      reviewSha256(
        canonicalReviewJson({
          identityKey: finding.identityKey,
          path: finding.file,
          supportingEvidence: finding.evidence.supportingEvidence.map(
            (support) => ({
              role: support.role,
              path: support.path,
              sourceDigest: support.sourceDigest,
              excerptDigest: support.excerpt.excerptDigest,
            }),
          ),
        }),
      ),
    "Finding occurrence digest is invalid.",
  );
}

function validateFindingEvidenceDigests(finding: RetainedFinding): void {
  const evidence = finding.evidence;
  const excerpts = evidence.supportingEvidence.map(
    (support) => support.excerpt,
  );
  if (evidence.anchorKind === "changed-text") {
    excerpts.push(evidence.excerpt);
    if (evidence.excerpt.kind === "clear") {
      requireBinding(
        finding.identity.causeDigest ===
          reviewSha256(
            evidence.excerpt.value.trim().replace(/[\t\n\v\f\r ]+/g, " "),
          ),
        "Finding text cause digest is invalid.",
      );
    }
  } else {
    requireBinding(
      finding.identity.causeDigest ===
        reviewSha256(
          canonicalReviewJson({
            beforeEntryDigest: evidence.beforeEntryDigest ?? null,
            afterEntryDigest: evidence.afterEntryDigest ?? null,
          }),
        ),
      "Finding tree cause digest is invalid.",
    );
  }
  for (const verification of finding.verification?.evidence ?? []) {
    const { sourceId, ...source } = verification.source;
    requireBinding(
      sourceId === reviewSha256(canonicalReviewJson(source)),
      "Verification source digest is invalid.",
    );
    if (verification.kind === "text") excerpts.push(verification.excerpt);
  }
  for (const excerpt of excerpts) {
    if (excerpt.kind === "clear")
      requireBinding(
        excerpt.excerptDigest === reviewSha256(excerpt.value),
        "Clear evidence excerpt digest is invalid.",
      );
  }
}

export function validateReviewStateBindings(state: ReviewStateV5): void {
  let previousIndex = 0n;
  for (const finding of state.findings) {
    const parts = reviewFindingIdPartsSchema.parse(finding.id);
    requireBinding(
      parts.index > previousIndex,
      "Retained findings are not in canonical ID order.",
    );
    previousIndex = parts.index;
    validateFindingIdentityDigests(finding);
    validateFindingEvidenceDigests(finding);
  }
}

export function validateReviewMetadataBindings(
  state: ReviewStateV5,
  metadata: ReviewMetadataV5,
): void {
  requireBinding(
    metadata.repositoryId === state.repositoryId &&
      metadata.pullRequestNumber === state.pullRequestNumber &&
      metadata.reviewedRevision === state.reviewedRevision &&
      metadata.generation === state.scopeCheckpoint.generation &&
      metadata.stateRevision === state.stateRevision &&
      metadata.run.id === state.manifestReference.workflowRunId &&
      metadata.run.attempt === state.manifestReference.workflowAttempt &&
      metadata.stateDigest === reviewSha256(canonicalReviewJson(state)),
    "Review metadata does not match its state.",
  );
}
