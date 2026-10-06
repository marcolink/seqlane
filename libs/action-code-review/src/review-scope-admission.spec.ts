// @test-scope ./review-report-classification.ts
// @test-scope ./review-report-authority.ts
// @test-scope ./review-scope-evidence.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewHistory } from "./contracts.js";
import { createReviewGitFixture } from "./review-git-fixture.test-support.js";
import { admitReviewScope } from "./review-scope-admission.js";
import { encodeReviewStateV5 } from "./review-state-codec.js";
import {
  createReviewStateFixture,
  createRetainedFindingFixture,
  reviewReportFixture,
} from "./review-state-fixture.test-support.js";

function authorityFixture(
  history: ReviewHistory = { comments: [], truncated: false },
) {
  return {
    listIssueComments: vi.fn(async () => ({
      items: history.comments.map((comment) => ({
        id: comment.id,
        user: { login: comment.author },
        author_association: comment.authorAssociation,
        body: comment.body,
        created_at: comment.createdAt,
        updated_at: comment.updatedAt ?? comment.createdAt,
      })),
      hasNextPage: history.truncated,
    })),
  };
}

const frozenPullRequest = {
  repositoryId: "1",
  pullRequestNumber: 112,
  targetBranch: "release",
  baseRevision: "b".repeat(40),
  headRevision: "c".repeat(40),
};
const fixtures: Awaited<ReturnType<typeof createReviewGitFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("trusted review scope admission", { timeout: 20_000 }, () => {
  it("reads authority itself and blocks duplicate current reports before Git work", async () => {
    const body = encodeReviewStateV5(createReviewStateFixture());
    const listIssueComments = vi.fn(async (_pr: number, page: number) => ({
      items: [
        {
          id: page === 1 ? 42 : 43,
          user: { login: "github-actions[bot]" },
          author_association: "NONE",
          body,
          created_at: "2026-10-06",
          updated_at: "2026-10-06",
        },
      ],
      hasNextPage: page === 1,
    }));
    const run = vi.fn();
    const fetchExactCommit = vi.fn();
    await expect(
      admitReviewScope(
        {
          pullRequest: frozenPullRequest,
        },
        {
          authority: { listIssueComments },
          git: { run, fetchExactCommit },
          admittedAt: performance.now(),
        },
      ),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_AMBIGUOUS" });
    expect(listIssueComments.mock.calls).toEqual([
      [112, 1],
      [112, 2],
      [112, 1],
      [112, 2],
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(fetchExactCommit).not.toHaveBeenCalled();
  });
  it.each([
    { comments: [], truncated: false },
    {
      comments: [
        reviewReportFixture(encodeReviewStateV5(createReviewStateFixture())),
      ],
      truncated: false,
    },
  ])(
    "rejects supplied history before authority lookup or Git work",
    async (history) => {
      const authority = authorityFixture();
      const run = vi.fn();
      const fetchExactCommit = vi.fn();
      await expect(
        admitReviewScope(
          { pullRequest: frozenPullRequest, history },
          {
            authority,
            git: { run, fetchExactCommit },
            admittedAt: performance.now(),
          },
        ),
      ).rejects.toMatchObject({ code: "REVIEW_ADMISSION_INVALID" });
      expect(authority.listIssueComments).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(fetchExactCommit).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      secondPage: { items: [], hasNextPage: true },
      code: "REVIEW_AUTHORITY_INCOMPLETE",
      calls: 3,
    },
    {
      secondPage: { items: [null], hasNextPage: false },
      code: "REVIEW_AUTHORITY_READ_FAILED",
      calls: 2,
    },
    {
      secondPage: {
        items: [
          {
            id: 42,
            user: { login: "github-actions[bot]" },
            author_association: "NONE",
            body: encodeReviewStateV5(createReviewStateFixture()),
            created_at: "2026-10-06",
            updated_at: "2026-10-06",
          },
        ],
        hasNextPage: false,
      },
      code: "REVIEW_AUTHORITY_UNSTABLE",
      calls: 2,
    },
  ])("blocks $code before Git work", async ({ secondPage, code, calls }) => {
    const listIssueComments = vi
      .fn()
      .mockResolvedValueOnce({ items: [], hasNextPage: false })
      .mockResolvedValue(secondPage);
    const run = vi.fn();
    const fetchExactCommit = vi.fn();
    await expect(
      admitReviewScope(
        { pullRequest: frozenPullRequest },
        {
          authority: { listIssueComments },
          git: { run, fetchExactCommit },
          admittedAt: performance.now(),
        },
      ),
    ).rejects.toMatchObject({ code });
    expect(listIssueComments).toHaveBeenCalledTimes(calls);
    expect(run).not.toHaveBeenCalled();
    expect(fetchExactCommit).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3, 4])(
    "ignores all v%s state and collects a full baseline",
    async (schemaVersion) => {
      const fixture = await createReviewGitFixture();
      fixtures.push(fixture);
      await fixture.write("first.ts", "base\n");
      await fixture.write("later.ts", "base\n");
      const baseRevision = await fixture.commit();
      await fixture.write("first.ts", "already reviewed\n");
      await fixture.commit();
      await fixture.write("later.ts", "new edit\n");
      const headRevision = await fixture.commit();
      const metadata = {
        schemaVersion,
        pullRequestNumber: 112,
        reviewedRevision: "a".repeat(40),
      };
      const result = await admitReviewScope(
        {
          pullRequest: {
            repositoryId: "1",
            pullRequestNumber: 112,
            targetBranch: "release",
            baseRevision,
            headRevision,
          },
        },
        {
          authority: authorityFixture({
            comments: [
              {
                id: "42",
                kind: "issue",
                author: "github-actions[bot]",
                authorAssociation: "NONE",
                createdAt: "2026-10-06",
                body: `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v${schemaVersion}: ${JSON.stringify(metadata)} -->\n<!-- seqlane-code-review-state-v${schemaVersion}-start -->${"!".repeat(20_001)}<!-- seqlane-code-review-state-v${schemaVersion}-end -->`,
              },
            ],
            truncated: false,
          }),
          git: fixture.git,
          admittedAt: performance.now(),
        },
      );
      expect(result.classification.kind).toBe("legacy");
      expect(result.scopeIdentity.mode).toBe("legacy-replacement");
      expect(result.retainedFindings).toEqual([]);
      expect(result.evidence.reviewablePaths).toEqual(["first.ts", "later.ts"]);
      expect(result.evidence.batches[0]?.patch).toContain("+already reviewed");
      expect(result.evidence.batches[0]?.patch).toContain("+new edit");
      expect(
        fixture.commands.filter(({ argv }) => argv.includes("--patch")),
      ).toHaveLength(1);
      expect(
        fixture.commands.some(({ argv }) =>
          argv.includes(metadata.reviewedRevision),
        ),
      ).toBe(false);
    },
  );
  it("routes valid current state through raw authority lookup to checkpoint-only evidence", async () => {
    const fixture = await createReviewGitFixture();
    fixtures.push(fixture);
    await fixture.write("first.ts", "base\n");
    await fixture.write("later.ts", "base\n");
    const baseRevision = await fixture.commit();
    await fixture.write("first.ts", "earlier reviewed defect\n");
    const checkpoint = await fixture.commit();
    const state = createReviewStateFixture(baseRevision, checkpoint);
    state.findings = [createRetainedFindingFixture(checkpoint)];
    state.nextFindingIndex = 2;
    const listIssueComments = vi.fn().mockResolvedValue({
      items: [
        {
          id: 42,
          user: { login: "github-actions[bot]" },
          author_association: "NONE",
          body: `<!-- seqlane-code-review-in-progress: old-v4-notice -->\n${encodeReviewStateV5(state)}`,
          created_at: "2026-10-06",
          updated_at: "2026-10-06",
        },
      ],
      hasNextPage: false,
    });
    await fixture.write("later.ts", "new edit\n");
    const headRevision = await fixture.commit();
    const result = await admitReviewScope(
      {
        pullRequest: {
          repositoryId: "1",
          pullRequestNumber: 112,
          targetBranch: "release",
          baseRevision,
          headRevision,
        },
      },
      {
        authority: { listIssueComments },
        git: fixture.git,
        admittedAt: performance.now(),
      },
    );
    expect(listIssueComments.mock.calls).toEqual([
      [112, 1],
      [112, 1],
    ]);
    expect(result.scopeIdentity).toMatchObject({
      mode: "incremental",
      checkpointRevision: checkpoint,
      reportId: "42",
    });
    expect(result.retainedFindings).toEqual(state.findings);
    expect(result.evidence.reviewablePaths).toEqual(["later.ts"]);
    expect(result.evidence.batches[0]?.patch).toContain("+new edit");
    expect(result.evidence.batches[0]?.patch).not.toContain(
      "earlier reviewed defect",
    );
    expect(result.evidence.validationBatches[0]?.patch).toContain("+new edit");
  });
  it("same-head admission uses the published checkpoint and makes no patch command", async () => {
    const fixture = await createReviewGitFixture();
    fixtures.push(fixture);
    await fixture.write("first.ts", "base\n");
    const baseRevision = await fixture.commit();
    await fixture.write("first.ts", "change\n");
    const headRevision = await fixture.commit();
    const state = createReviewStateFixture(baseRevision, headRevision);
    const result = await admitReviewScope(
      {
        pullRequest: {
          repositoryId: "1",
          pullRequestNumber: 112,
          targetBranch: "release",
          baseRevision,
          headRevision,
        },
      },
      {
        authority: authorityFixture({
          comments: [reviewReportFixture(encodeReviewStateV5(state))],
          truncated: false,
        }),
        git: fixture.git,
        admittedAt: performance.now(),
      },
    );
    expect(result.scopeIdentity.mode).toBe("no-change");
    expect(result.evidence.batches).toEqual([]);
    expect(result.evidence.validationBatches).toEqual([]);
    expect(fixture.commands.some(({ argv }) => argv.includes("--patch"))).toBe(
      false,
    );
  });
  it("does not send the earlier hunk of a newly edited file back to discovery", async () => {
    const fixture = await createReviewGitFixture();
    fixtures.push(fixture);
    const lines = Array.from(
      { length: 100 },
      (_, index) => `line ${index + 1}`,
    );
    await fixture.write("first.ts", lines.join("\n") + "\n");
    const baseRevision = await fixture.commit();
    lines[0] = "earlier reviewed cause";
    await fixture.write("first.ts", lines.join("\n") + "\n");
    const checkpoint = await fixture.commit();
    const state = createReviewStateFixture(baseRevision, checkpoint);
    lines[70] = "new changed cause";
    await fixture.write("first.ts", lines.join("\n") + "\n");
    const headRevision = await fixture.commit();
    const result = await admitReviewScope(
      {
        pullRequest: {
          repositoryId: "1",
          pullRequestNumber: 112,
          targetBranch: "release",
          baseRevision,
          headRevision,
        },
      },
      {
        authority: authorityFixture({
          comments: [reviewReportFixture(encodeReviewStateV5(state))],
          truncated: false,
        }),
        git: fixture.git,
        admittedAt: performance.now(),
      },
    );
    expect(result.evidence.batches[0]?.patch).toContain("+new changed cause");
    expect(result.evidence.batches[0]?.patch).not.toContain(
      "earlier reviewed cause",
    );
    expect(result.evidence.validationBatches[0]?.patch).toContain(
      "+earlier reviewed cause",
    );
  });
  it("accepts a non-ancestor checkpoint without resetting its generation", async () => {
    const fixture = await createReviewGitFixture();
    fixtures.push(fixture);
    await fixture.write("first.ts", "base\n");
    const baseRevision = await fixture.commit();
    await fixture.write("first.ts", "old branch\n");
    const checkpoint = await fixture.commit();
    const state = createReviewStateFixture(baseRevision, checkpoint);
    await fixture.run("checkout", "-q", "--detach", baseRevision);
    await fixture.write("first.ts", "rebased branch\n");
    const headRevision = await fixture.commit();
    const result = await admitReviewScope(
      {
        pullRequest: {
          repositoryId: "1",
          pullRequestNumber: 112,
          targetBranch: "retargeted",
          baseRevision,
          headRevision,
        },
      },
      {
        authority: authorityFixture({
          comments: [reviewReportFixture(encodeReviewStateV5(state))],
          truncated: false,
        }),
        git: fixture.git,
        admittedAt: performance.now(),
      },
    );
    expect(result.classification.kind).toBe("current");
    expect(result.scopeIdentity).toMatchObject({
      checkpointRevision: checkpoint,
      targetBranch: "retargeted",
    });
    expect(result.evidence.batches[0]?.patch).toContain(
      "-old branch\n+rebased branch",
    );
  });
  it("absent report and excluded-only edits preserve their baseline mode without patch work", async () => {
    const fixture = await createReviewGitFixture();
    fixtures.push(fixture);
    await fixture.write("first.ts", "base\n");
    const baseRevision = await fixture.commit();
    await fixture.write("pnpm-lock.yaml", "ignored\n");
    const headRevision = await fixture.commit();
    const result = await admitReviewScope(
      {
        pullRequest: {
          repositoryId: "1",
          pullRequestNumber: 112,
          targetBranch: "release",
          baseRevision,
          headRevision,
        },
      },
      {
        authority: authorityFixture(),
        git: fixture.git,
        admittedAt: performance.now(),
      },
    );
    expect(result.scopeIdentity.mode).toBe("new-baseline");
    expect(result.evidence.excludedPaths).toEqual(["pnpm-lock.yaml"]);
    expect(result.evidence.batches).toEqual([]);
    expect(fixture.commands.some(({ argv }) => argv.includes("--patch"))).toBe(
      false,
    );
  });
  it.each([
    {
      comments: [
        reviewReportFixture(
          `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v4: {"schemaVersion":5,"schemaVersion":4,"pullRequestNumber":112,"reviewedRevision":"${"c".repeat(40)}"} -->`,
        ),
      ],
      truncated: false,
    },
    {
      comments: [
        reviewReportFixture(
          '<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v5: {"schemaVersion":5,"pullRequestNumber":112,"reviewedRevision":"' +
            "c".repeat(40) +
            '"} -->\nmalformed',
        ),
      ],
      truncated: false,
    },
    {
      comments: [
        reviewReportFixture(
          '<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v6: {"schemaVersion":6,"pullRequestNumber":112,"reviewedRevision":"' +
            "c".repeat(40) +
            '"} -->',
        ),
      ],
      truncated: false,
    },
    {
      comments: [
        reviewReportFixture(
          encodeReviewStateV5(createReviewStateFixture()),
          "42",
        ),
        reviewReportFixture(
          encodeReviewStateV5(createReviewStateFixture()),
          "43",
        ),
      ],
      truncated: false,
    },
    { comments: [], truncated: true },
  ])("rejects unsafe report input before Git work", async (history) => {
    const run = vi.fn();
    const fetchExactCommit = vi.fn();
    await expect(
      admitReviewScope(
        {
          pullRequest: {
            repositoryId: "1",
            pullRequestNumber: 112,
            targetBranch: "release",
            baseRevision: "b".repeat(40),
            headRevision: "c".repeat(40),
          },
        },
        {
          authority: authorityFixture(history),
          git: { run, fetchExactCommit },
          admittedAt: performance.now(),
        },
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(fetchExactCommit).not.toHaveBeenCalled();
  });
  it("rejects a foreign repository and cancellation before Git work", async () => {
    const run = vi.fn();
    const input = {
      pullRequest: {
        repositoryId: "99",
        pullRequestNumber: 112,
        targetBranch: "release",
        baseRevision: "b".repeat(40),
        headRevision: "c".repeat(40),
      },
    };
    const authority = authorityFixture({
      comments: [
        reviewReportFixture(encodeReviewStateV5(createReviewStateFixture())),
      ],
      truncated: false,
    });
    await expect(
      admitReviewScope(input, {
        authority,
        git: { run },
        admittedAt: performance.now(),
      }),
    ).rejects.toMatchObject({ code: "REVIEW_REPORT_INVALID" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      admitReviewScope(input, {
        authority,
        git: { run },
        admittedAt: performance.now(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_ADMISSION_CANCELLED" });
    expect(run).not.toHaveBeenCalled();
    expect(authority.listIssueComments).toHaveBeenCalledTimes(2);
  });
});
