import {
  retainedFindingSchema,
  reviewStateV5Schema,
  type RetainedFinding,
  type ReviewStateV5,
} from "@seqlane/code-review-workflow/contracts";
import { canonicalReviewJson, reviewSha256 } from "./review-state-canonical.js";

export const FIXTURE_GENERATION = "0123456789abcdef0123456789abcdef";
export function createRetainedFindingFixture(
  headRevision: string,
  index = 1,
): RetainedFinding {
  const identity = {
    schemaVersion: "review.finding-identity/v1",
    defectKind: "missing-guard",
    anchorKind: "changed-text",
    causeDigest: reviewSha256("unsafe call"),
  };
  const identityKey = reviewSha256(canonicalReviewJson(identity));
  return retainedFindingSchema.parse({
    schemaVersion: 1,
    id: `SEQ-PR112-G${FIXTURE_GENERATION}-${String(index).padStart(3, "0")}`,
    identity,
    identityKey,
    occurrenceKey: reviewSha256(
      canonicalReviewJson({
        identityKey,
        path: "first.ts",
        supportingEvidence: [],
      }),
    ),
    severity: "required",
    status: "new",
    comparisonOutcome: "new",
    axis: "correctness",
    summary: "A guard is missing",
    recommendation: "Add a guard",
    file: "first.ts",
    firstObservedRevision: headRevision,
    evidenceHeadRevision: headRevision,
    evidenceRunId: "fixture-run",
    evidence: {
      itemId: "item-1",
      evidenceForm: "pr-patch",
      itemEvidenceDigest: reviewSha256("item"),
      path: "first.ts",
      supportingEvidence: [],
      anchorKind: "changed-text",
      side: "new",
      sourceRevision: headRevision,
      sourceDigest: reviewSha256("source"),
      excerpt: {
        kind: "clear",
        value: "unsafe call",
        excerptDigest: reviewSha256("unsafe call"),
      },
      changedStartLine: 1,
      changedEndLine: 1,
    },
    location: { kind: "located", side: "new", startLine: 1, endLine: 1 },
    verification: null,
  });
}

export function createReviewStateFixture(
  baseRevision = "b".repeat(40),
  reviewedRevision = "c".repeat(40),
): ReviewStateV5 {
  const scopeIdentityDigest = reviewSha256("scope");
  const source = {
    kind: "review",
    sourceRunId: "100",
    sourceAttempt: 1,
    scopeIdentityDigest,
  };
  return reviewStateV5Schema.parse({
    schemaVersion: 5,
    stateRevision: 1,
    repositoryId: "1",
    pullRequestNumber: 112,
    baseRevision,
    reviewedRevision,
    nextFindingIndex: 1,
    findings: [],
    limitations: [],
    scopeCheckpoint: {
      version: 1,
      generation: FIXTURE_GENERATION,
      baselineRevision: reviewedRevision,
      baseBranch: "release",
      lastMode: "baseline",
    },
    runStatus: {
      coverage: "complete",
      finding: "valid",
      publication: "published",
      admission: "admissible",
    },
    manifestReference: {
      schemaVersion: 1,
      manifestSchema: "review.run-manifest/v1",
      repositoryId: "1",
      pullRequestNumber: 112,
      workflowId: "2",
      workflowPath: ".github/workflows/seqlane-code-review.yml",
      workflowDefinitionRevision: baseRevision,
      workflowRunId: "100",
      workflowAttempt: 1,
      manifestRunId: "fixture-run",
      reviewedRevision,
      scopeIdentityDigest,
      artifactId: "3",
      artifactName: "seqlane-review",
      compressedBytes: 100,
      uncompressedBytes: 200,
      digest: reviewSha256("manifest"),
      readback: "verified",
    },
    manifestSummary: {
      itemCount: 1,
      selectedPathCount: 1,
      expectedLaneCount: 3,
      completedLaneCount: 3,
    },
    publicationOperation: {
      schemaVersion: 1,
      writerKind: "full-review",
      pullRequestNumber: 112,
      stateRevision: 1,
      writerRunId: "101",
      writerAttempt: 1,
      source,
      payloadDigest: reviewSha256("payload"),
    },
    consumedSources: [source],
    publishedCost: {
      periodStart: "2026-10-06T12:00:00Z",
      knownUsd: "0.1",
      publishedRunCount: 1,
      completeness: "complete",
      lastRun: { runId: "100", attempt: 1 },
      lastRunKnownUsd: "0.1",
      highWater: { runId: "100", attempt: 1 },
    },
  });
}

export function reviewReportFixture(body: string, id = "42") {
  return {
    id,
    kind: "issue" as const,
    author: "github-actions[bot]",
    authorAssociation: "NONE",
    createdAt: "2026-10-06",
    body,
  };
}
