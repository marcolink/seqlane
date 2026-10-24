// @test-scope ../../../workflows/code-review/review-v5-state.ts
// @test-scope ../../../workflows/code-review/review-v5-findings.ts
// @test-scope ../../../workflows/code-review/review-v5-evidence.ts
// @test-scope ../../../workflows/code-review/review-v5-publication.ts
// @test-scope ../../../workflows/code-review/review-v5-primitives.ts
import { describe, expect, it } from "vitest";
import {
  reviewStateV5Schema,
  retainedFindingSchema,
  reviewFindingEvidenceSchema,
  reviewVerificationEvidenceSchema,
  reviewRunStatusSchema,
  reviewPublishedCostSchema,
  reviewManifestReferenceSchema,
  reviewCanonicalPathSchema,
  reviewUtf8StringSchema,
} from "@seqlane/code-review-workflow/contracts";
import {
  createRetainedFindingFixture,
  createReviewStateFixture,
} from "./review-state-fixture.test-support.js";

describe("one strict v5 state", () => {
  it("returns validation failures for malformed numeric identities without throwing", () => {
    const state = createReviewStateFixture();
    for (const runId of ["bad", "-1", "0", "1".repeat(129)]) {
      expect(
        reviewPublishedCostSchema.safeParse({
          ...state.publishedCost,
          lastRun: { runId, attempt: 1 },
          highWater: { runId, attempt: 1 },
        }).success,
      ).toBe(false);
    }
    for (const nextFindingIndex of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        reviewStateV5Schema.safeParse({ ...state, nextFindingIndex }).success,
      ).toBe(false);
    for (const id of [
      "bad",
      `SEQ-PR112-G${state.scopeCheckpoint.generation}-${"1".repeat(128)}`,
    ]) {
      const finding = createRetainedFindingFixture(state.reviewedRevision);
      expect(
        reviewStateV5Schema.safeParse({
          ...state,
          findings: [{ ...finding, id }],
        }).success,
      ).toBe(false);
    }
  });
  it("accepts complete state and rejects missing required models and old fields", () => {
    const state = createReviewStateFixture();
    expect(reviewStateV5Schema.safeParse(state).success).toBe(true);
    expect(
      reviewStateV5Schema.safeParse({ ...state, manifestReference: undefined })
        .success,
    ).toBe(false);
    expect(reviewStateV5Schema.safeParse({ ...state, run: {} }).success).toBe(
      false,
    );
    expect(
      reviewStateV5Schema.safeParse({ ...state, schemaVersion: 4 }).success,
    ).toBe(false);
  });
  it.each([
    "repositoryId",
    "reviewedRevision",
    "scopeIdentityDigest",
    "workflowRunId",
  ] as const)("rejects mismatched manifest %s", (field) => {
    const state = createReviewStateFixture();
    state.manifestReference[field] =
      field === "repositoryId" || field === "workflowRunId"
        ? "99"
        : "a".repeat(field === "reviewedRevision" ? 40 : 64);
    expect(reviewStateV5Schema.safeParse(state).success).toBe(false);
  });
  it("rejects foreign generation, duplicate numeric IDs, and reused next indexes", () => {
    const state = createReviewStateFixture();
    state.findings = [createRetainedFindingFixture(state.reviewedRevision)];
    state.nextFindingIndex = 2;
    expect(reviewStateV5Schema.safeParse(state).success).toBe(true);
    state.findings[0]!.id = state.findings[0]!.id.replace(
      "SEQ-PR112",
      "SEQ-PR113",
    );
    expect(reviewStateV5Schema.safeParse(state).success).toBe(false);
    state.findings = [
      createRetainedFindingFixture(state.reviewedRevision),
      createRetainedFindingFixture(state.reviewedRevision),
    ];
    state.findings[1]!.id = state.findings[1]!.id.replace("-001", "-0001");
    expect(reviewStateV5Schema.safeParse(state).success).toBe(false);
    state.findings = [createRetainedFindingFixture(state.reviewedRevision)];
    state.nextFindingIndex = 1;
    expect(reviewStateV5Schema.safeParse(state).success).toBe(false);
  });
  it("rejects incomplete published states and conflicting operation/source/cost identity", () => {
    const state = createReviewStateFixture();
    state.runStatus.coverage = "incomplete";
    expect(reviewStateV5Schema.safeParse(state).success).toBe(false);
    const wrongOperation = createReviewStateFixture();
    wrongOperation.publicationOperation.stateRevision += 1;
    expect(reviewStateV5Schema.safeParse(wrongOperation).success).toBe(false);
    const missingSource = createReviewStateFixture();
    missingSource.consumedSources = [];
    expect(reviewStateV5Schema.safeParse(missingSource).success).toBe(false);
    const cost = createReviewStateFixture();
    cost.publishedCost.lastRunKnownUsd = null;
    expect(reviewStateV5Schema.safeParse(cost).success).toBe(false);
    cost.publishedCost.completeness = "incomplete";
    expect(reviewStateV5Schema.safeParse(cost).success).toBe(true);
  });
  it("preserves historical evidence and withheld excerpts without requiring an old artifact", () => {
    const finding = createRetainedFindingFixture("a".repeat(40));
    finding.comparisonOutcome = "not_reviewed";
    if (finding.evidence.anchorKind === "changed-text")
      finding.evidence.excerpt = {
        kind: "withheld",
        excerptDigest: "d".repeat(64),
        redactionPolicyId: "review.secret-redaction/v1",
        ruleIds: ["credential"],
      };
    const state = createReviewStateFixture();
    state.findings = [finding];
    state.nextFindingIndex = 2;
    expect(reviewStateV5Schema.parse(state).findings[0]).toEqual(finding);
  });
  it("checks UTF-8 bytes, invalid Unicode, and canonical paths", () => {
    expect(reviewCanonicalPathSchema.parse("\ufefffile.ts")).toBe(
      "\ufefffile.ts",
    );
    expect(reviewUtf8StringSchema(500).safeParse("é".repeat(250)).success).toBe(
      true,
    );
    expect(reviewUtf8StringSchema(500).safeParse("é".repeat(251)).success).toBe(
      false,
    );
    expect(reviewUtf8StringSchema(500).safeParse("\ud800").success).toBe(false);
    for (const path of [
      "../file",
      "/file",
      "a//b",
      "C:\\file",
      "a/./b",
      "a\0b",
    ])
      expect(reviewCanonicalPathSchema.safeParse(path).success).toBe(false);
  });
  it("rejects evidence/location disagreement and invalid verification ownership", () => {
    const finding = createRetainedFindingFixture("c".repeat(40));
    expect(
      retainedFindingSchema.safeParse({ ...finding, file: "other.ts" }).success,
    ).toBe(false);
    expect(
      retainedFindingSchema.safeParse({
        ...finding,
        location: { kind: "located", side: "old", startLine: 1, endLine: 1 },
      }).success,
    ).toBe(false);
    expect(
      reviewFindingEvidenceSchema.safeParse({
        ...finding.evidence,
        changedEndLine: 0,
      }).success,
    ).toBe(false);
    const source = {
      kind: "absent",
      sourceId: "a".repeat(64),
      findingId: finding.id,
      path: finding.file,
      sourceRevision: "c".repeat(40),
      treeObjectId: "b".repeat(40),
    };
    expect(
      reviewVerificationEvidenceSchema.safeParse({
        kind: "text",
        source,
        startLine: 1,
        endLine: 1,
        excerpt: {
          kind: "clear",
          value: "source",
          excerptDigest: "a".repeat(64),
        },
      }).success,
    ).toBe(false);
    expect(
      retainedFindingSchema.safeParse({
        ...finding,
        verification: {
          headRevision: "c".repeat(40),
          outcome: "present",
          evidence: [{ kind: "tree-entry", source }],
        },
      }).success,
    ).toBe(false);
  });
  it("enforces manifest and run-status boundaries", () => {
    const reference = createReviewStateFixture().manifestReference;
    expect(
      reviewManifestReferenceSchema.safeParse({
        ...reference,
        compressedBytes: 512 * 1024,
        uncompressedBytes: 2 * 1024 * 1024,
      }).success,
    ).toBe(true);
    expect(
      reviewManifestReferenceSchema.safeParse({
        ...reference,
        compressedBytes: 512 * 1024 + 1,
      }).success,
    ).toBe(false);
    expect(
      reviewManifestReferenceSchema.safeParse({
        ...reference,
        digest: "missing",
      }).success,
    ).toBe(false);
    expect(
      reviewRunStatusSchema.safeParse({
        coverage: "complete",
        finding: "valid",
        publication: "published",
        admission: "blocked",
      }).success,
    ).toBe(false);
  });
  it("requires present verification for reopening and permits historical carry-forward", () => {
    const finding = createRetainedFindingFixture("c".repeat(40));
    finding.status = "reopened";
    finding.comparisonOutcome = "persisting";
    expect(retainedFindingSchema.safeParse(finding).success).toBe(false);
    finding.verification = {
      headRevision: finding.evidenceHeadRevision,
      outcome: "uncertain",
      evidence: [
        {
          kind: "tree-entry",
          source: {
            kind: "present",
            sourceId: "a".repeat(64),
            findingId: finding.id,
            path: finding.file,
            sourceRevision: finding.evidenceHeadRevision,
            treeObjectId: "c".repeat(40),
            entryDigest: "d".repeat(64),
            sourceDigest: "e".repeat(64),
          },
        },
      ],
    };
    expect(retainedFindingSchema.safeParse(finding).success).toBe(false);
    finding.verification.outcome = "present";
    expect(retainedFindingSchema.safeParse(finding).success).toBe(true);
    const state = createReviewStateFixture("b".repeat(40), "d".repeat(40));
    state.findings = [finding];
    state.nextFindingIndex = 2;
    expect(reviewStateV5Schema.safeParse(state).success).toBe(false);
    finding.comparisonOutcome = "not_reviewed";
    expect(reviewStateV5Schema.safeParse(state).success).toBe(true);
  });
});
