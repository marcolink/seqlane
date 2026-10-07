// @test-scope ../../../workflows/code-review/review-v5-findings.ts
// @test-scope ../../../workflows/code-review/review-v5-state.ts
// @test-scope ./review-state-codec.ts
// @test-scope ./review-scope-admission.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import {
  retainedFindingSchema,
  reviewStateV5Schema,
  type RetainedFinding,
} from "@seqlane/code-review-workflow/contracts";
import { admitReviewScope } from "./review-scope-admission.js";
import { encodeReviewStateV5 } from "./review-state-codec.js";
import { canonicalReviewJson, reviewSha256 } from "./review-state-canonical.js";
import {
  createRetainedFindingFixture,
  createReviewStateFixture,
} from "./review-state-fixture.test-support.js";
import { createReviewGitFixture } from "./review-git-fixture.test-support.js";

function verificationFixture(
  finding: RetainedFinding,
  outcome: NonNullable<RetainedFinding["verification"]>["outcome"],
) {
  const source = {
    kind: "present",
    findingId: finding.id,
    path: finding.file,
    sourceRevision: finding.evidenceHeadRevision,
    treeObjectId: finding.evidenceHeadRevision,
    entryDigest: reviewSha256("verified entry"),
    sourceDigest: reviewSha256("verified source"),
  };
  return retainedFindingSchema.shape.verification.unwrap().parse({
    headRevision: finding.evidenceHeadRevision,
    outcome,
    evidence: [
      {
        kind: "tree-entry",
        source: {
          ...source,
          sourceId: reviewSha256(canonicalReviewJson(source)),
        },
      },
    ],
  });
}

function authorityFixture(body: string) {
  return {
    listIssueComments: vi.fn().mockResolvedValue({
      items: [
        {
          id: 42,
          body,
          user: { login: "github-actions[bot]" },
          author_association: "NONE",
          created_at: "2026-10-06",
          updated_at: "2026-10-06",
        },
      ],
      hasNextPage: false,
    }),
  };
}

const fixtures: Awaited<ReturnType<typeof createReviewGitFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("verified finding lifecycle", () => {
  it("blocks a resolved/persisting claim without verification at schema and admission boundaries", async () => {
    const state = createReviewStateFixture();
    const finding = createRetainedFindingFixture(state.reviewedRevision);
    state.findings = [finding];
    state.nextFindingIndex = 2;
    const validBody = encodeReviewStateV5(state);
    finding.status = "resolved";
    finding.comparisonOutcome = "persisting";
    expect(retainedFindingSchema.safeParse(finding).success).toBe(false);
    expect(reviewStateV5Schema.safeParse(state).success).toBe(false);
    const text = canonicalReviewJson(state);
    const body = validBody
      .replace(
        /"stateDigest":"[a-f0-9]+"/,
        `"stateDigest":"${reviewSha256(text)}"`,
      )
      .replace(
        /"data":"[^"]+"/,
        `"data":"${gzipSync(text, { level: 9 }).toString("base64")}"`,
      );
    const authority = authorityFixture(body);
    const run = vi.fn();
    const fetchExactCommit = vi.fn();
    await expect(
      admitReviewScope(
        {
          pullRequest: {
            repositoryId: "1",
            pullRequestNumber: 112,
            targetBranch: "release",
            baseRevision: state.baseRevision,
            headRevision: state.reviewedRevision,
          },
        },
        {
          authority,
          git: { run, fetchExactCommit },
        },
      ),
    ).rejects.toMatchObject({ code: "REVIEW_REPORT_INVALID" });
    expect(authority.listIssueComments).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(fetchExactCommit).not.toHaveBeenCalled();
  });
  it.each([
    ["resolved", "persisting", null],
    ["resolved", "persisting", "absent"],
    ["resolved", "new", "absent"],
    ["resolved", "resolved", null],
    ["resolved", "resolved", "present"],
    ["resolved", "resolved", "uncertain"],
    ["resolved", "not_reviewed", null],
    ["resolved", "not_reviewed", "present"],
    ["reopened", "persisting", null],
    ["reopened", "persisting", "uncertain"],
    ["reopened", "new", "present"],
    ["reopened", "resolved", "present"],
    ["reopened", "not_reviewed", null],
    ["new", "persisting", null],
    ["new", "new", "absent"],
    ["open", "new", null],
    ["open", "resolved", "absent"],
    ["open", "persisting", "absent"],
    ["addressed", "new", null],
    ["addressed", "persisting", "present"],
    ["addressed", "persisting", "absent"],
  ] as const)(
    "rejects contradictory %s/%s/%s",
    (status, comparisonOutcome, outcome) => {
      const state = createReviewStateFixture();
      const original = createRetainedFindingFixture(state.reviewedRevision);
      const finding = {
        ...original,
        status,
        comparisonOutcome,
        verification:
          outcome === null ? null : verificationFixture(original, outcome),
      };
      expect(retainedFindingSchema.safeParse(finding).success).toBe(false);
      expect(
        reviewStateV5Schema.safeParse({
          ...state,
          findings: [finding],
          nextFindingIndex: 2,
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    ["new", "new", null],
    ["new", "new", "present"],
    ["new", "new", "uncertain"],
    ["open", "persisting", null],
    ["open", "persisting", "present"],
    ["open", "persisting", "uncertain"],
    ["addressed", "persisting", null],
    ["addressed", "persisting", "uncertain"],
    ["resolved", "resolved", "absent"],
    ["reopened", "persisting", "present"],
  ] as const)(
    "accepts supported %s/%s/%s at the current head",
    (status, comparisonOutcome, outcome) => {
      const state = createReviewStateFixture();
      const original = createRetainedFindingFixture(state.reviewedRevision);
      const finding = {
        ...original,
        status,
        comparisonOutcome,
        verification:
          outcome === null ? null : verificationFixture(original, outcome),
      };
      expect(retainedFindingSchema.safeParse(finding).success).toBe(true);
      expect(
        reviewStateV5Schema.safeParse({
          ...state,
          findings: [finding],
          nextFindingIndex: 2,
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    ["new", null],
    ["open", "present"],
    ["addressed", "uncertain"],
    ["resolved", "absent"],
    ["reopened", "present"],
  ] as const)("preserves historical %s as not_reviewed", (status, outcome) => {
    const state = createReviewStateFixture();
    const original = createRetainedFindingFixture("a".repeat(40));
    const finding = {
      ...original,
      status,
      comparisonOutcome: "not_reviewed",
      verification:
        outcome === null ? null : verificationFixture(original, outcome),
    };
    expect(retainedFindingSchema.safeParse(finding).success).toBe(true);
    expect(
      reviewStateV5Schema.parse({
        ...state,
        findings: [finding],
        nextFindingIndex: 2,
      }).findings[0],
    ).toEqual(finding);
  });
  it.each([
    ["resolved", "resolved", "absent"],
    ["reopened", "persisting", "present"],
  ] as const)(
    "rejects stale verification for a fresh %s transition",
    (status, comparisonOutcome, outcome) => {
      const state = createReviewStateFixture();
      const original = createRetainedFindingFixture("a".repeat(40));
      const finding = {
        ...original,
        status,
        comparisonOutcome,
        verification: verificationFixture(original, outcome),
      };
      expect(retainedFindingSchema.safeParse(finding).success).toBe(true);
      expect(
        reviewStateV5Schema.safeParse({
          ...state,
          findings: [finding],
          nextFindingIndex: 2,
        }).success,
      ).toBe(false);
    },
  );
  it.each(["resolved", "reopened"] as const)(
    "admits historical %s without fresh verification or patch work",
    async (status) => {
      const fixture = await createReviewGitFixture();
      fixtures.push(fixture);
      await fixture.write("first.ts", "base\n");
      const baseRevision = await fixture.commit();
      await fixture.write("first.ts", "verified change\n");
      const verifiedRevision = await fixture.commit();
      await fixture.write("later.ts", "unrelated change\n");
      const reviewedRevision = await fixture.commit();
      const state = createReviewStateFixture(baseRevision, reviewedRevision);
      const finding = createRetainedFindingFixture(verifiedRevision);
      finding.status = status;
      finding.comparisonOutcome = "not_reviewed";
      finding.verification = verificationFixture(
        finding,
        status === "resolved" ? "absent" : "present",
      );
      state.findings = [finding];
      state.nextFindingIndex = 2;
      state.previousReviewedRevision = verifiedRevision;
      state.scopeCheckpoint = {
        ...state.scopeCheckpoint,
        baselineRevision: verifiedRevision,
        lastMode: "incremental",
        fromRevision: verifiedRevision,
      };
      const result = await admitReviewScope(
        {
          pullRequest: {
            repositoryId: "1",
            pullRequestNumber: 112,
            targetBranch: "release",
            baseRevision,
            headRevision: reviewedRevision,
          },
        },
        {
          authority: authorityFixture(encodeReviewStateV5(state)),
          git: fixture.git,
        },
      );
      expect(result.scopeIdentity.mode).toBe("no-change");
      expect(result.retainedFindings).toEqual([finding]);
      expect(
        fixture.commands.some(({ argv }) => argv.includes("--patch")),
      ).toBe(false);
    },
    20_000,
  );
});
