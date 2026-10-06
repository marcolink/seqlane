import { describe, expect, it, vi } from "vitest";
import {
  readReviewAuthority,
  selectReviewAuthority,
} from "./review-report-authority.js";
import { reviewReportFixture } from "./review-state-fixture.test-support.js";

const platformComment = {
  id: 42,
  body: "<!-- seqlane-code-review -->",
  user: { login: "github-actions[bot]" },
  author_association: "NONE",
  created_at: "2026-10-06",
  updated_at: "2026-10-06",
};
describe("complete trusted authority", () => {
  it("rejects a deletion that hides a surviving report across pages", async () => {
    let comments = Array.from({ length: 101 }, (_, index) => ({
      ...platformComment,
      id: index + 1,
      user: { login: index === 100 ? "github-actions[bot]" : "human" },
    }));
    const listIssueComments = vi.fn(async (_pr: number, page: number) => {
      const start = (page - 1) * 100;
      const result = {
        items: comments.slice(start, start + 100),
        hasNextPage: start + 100 < comments.length,
      };
      if (listIssueComments.mock.calls.length === 1)
        comments = comments.slice(1);
      return result;
    });
    await expect(
      readReviewAuthority({ listIssueComments }, 178),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_UNSTABLE" });
    expect(comments.at(-1)?.id).toBe(101);
    expect(listIssueComments.mock.calls).toEqual([
      [178, 1],
      [178, 2],
      [178, 1],
    ]);
  });
  it("reads every bounded page through the raw port", async () => {
    const listIssueComments = vi.fn(async (_pr: number, page: number) =>
      page === 1
        ? {
            items: [{ ...platformComment, id: 1, user: { login: "human" } }],
            hasNextPage: true,
          }
        : { items: [platformComment], hasNextPage: false },
    );
    const history = await readReviewAuthority({ listIssueComments }, 112);
    expect(listIssueComments.mock.calls).toEqual([
      [112, 1],
      [112, 2],
      [112, 1],
      [112, 2],
    ]);
    expect(selectReviewAuthority(history)?.id).toBe("42");
  });
  it.each([
    { body: `${platformComment.body}\nupdated report` },
    { updated_at: "2026-10-07" },
    { user: { login: "human" } },
    { id: 43 },
  ])(
    "rejects changed authority evidence without retrying: %j",
    async (change) => {
      const listIssueComments = vi
        .fn()
        .mockResolvedValueOnce({ items: [platformComment], hasNextPage: false })
        .mockResolvedValueOnce({
          items: [{ ...platformComment, ...change }],
          hasNextPage: false,
        });
      await expect(
        readReviewAuthority({ listIssueComments }, 178),
      ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_UNSTABLE" });
      expect(listIssueComments).toHaveBeenCalledTimes(2);
    },
  );
  it("requires complete pagination on the second scan too", async () => {
    const listIssueComments = vi
      .fn()
      .mockResolvedValueOnce({ items: [], hasNextPage: false })
      .mockResolvedValue({ items: [platformComment], hasNextPage: true });
    await expect(
      readReviewAuthority({ listIssueComments }, 178),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_INCOMPLETE" });
    expect(listIssueComments).toHaveBeenCalledTimes(3);
  });
  it("requires valid raw evidence on the second scan too", async () => {
    const listIssueComments = vi
      .fn()
      .mockResolvedValueOnce({ items: [], hasNextPage: false })
      .mockResolvedValueOnce({ items: [null], hasNextPage: false });
    await expect(
      readReviewAuthority({ listIssueComments }, 178),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_READ_FAILED" });
    expect(listIssueComments).toHaveBeenCalledTimes(2);
  });
  it("refuses incomplete pagination without an unbounded scan", async () => {
    const listIssueComments = vi
      .fn()
      .mockResolvedValue({ items: [], hasNextPage: true });
    await expect(
      readReviewAuthority({ listIssueComments }, 112),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_INCOMPLETE" });
    expect(listIssueComments).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    { items: [null], hasNextPage: false },
    {
      items: [{ ...platformComment, id: Number.MAX_SAFE_INTEGER + 1 }],
      hasNextPage: false,
    },
    [platformComment],
  ])("does not silently discard malformed page evidence: %j", async (page) => {
    await expect(
      readReviewAuthority({ listIssueComments: async () => page }, 112),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_READ_FAILED" });
  });
  it("preserves lookup error causes", async () => {
    const cause = new Error("API unavailable");
    await expect(
      readReviewAuthority(
        {
          listIssueComments: async () => {
            throw cause;
          },
        },
        112,
      ),
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORITY_READ_FAILED", cause });
  });
  it("ignores untrusted authors and inline review comments", () => {
    const report = reviewReportFixture(platformComment.body);
    expect(
      selectReviewAuthority({
        comments: [{ ...report, author: "human" }],
        truncated: false,
      }),
    ).toBeUndefined();
    expect(
      selectReviewAuthority({
        comments: [{ ...report, kind: "review" }],
        truncated: false,
      }),
    ).toBeUndefined();
    expect(
      selectReviewAuthority(
        { comments: [{ ...report, author: "custom-bot" }], truncated: false },
        ["custom-bot"],
      )?.id,
    ).toBe("42");
  });
  it.each([
    { comments: [], truncated: true },
    {
      comments: [
        { ...reviewReportFixture(platformComment.body), bodyTruncated: true },
      ],
      truncated: false,
    },
  ])("rejects truncated inventory", (history) => {
    expect(() => selectReviewAuthority(history)).toThrow("incomplete");
  });
  it("refuses duplicates instead of choosing the newest", () => {
    expect(() =>
      selectReviewAuthority({
        comments: [
          reviewReportFixture(platformComment.body),
          reviewReportFixture(platformComment.body, "43"),
        ],
        truncated: false,
      }),
    ).toThrow("Multiple trusted");
    expect(() =>
      selectReviewAuthority({
        comments: [
          reviewReportFixture("human", "42"),
          reviewReportFixture("human", "42"),
        ],
        truncated: false,
      }),
    ).toThrow("duplicate identities");
  });
  it("enforces comment UTF-8 bytes and marker uniqueness", () => {
    expect(() =>
      selectReviewAuthority({
        comments: [
          reviewReportFixture(platformComment.body + "é".repeat(33_000)),
        ],
        truncated: false,
      }),
    ).toThrow("byte bound");
    expect(() =>
      selectReviewAuthority({
        comments: [reviewReportFixture(platformComment.body.repeat(2))],
        truncated: false,
      }),
    ).toThrow("marker");
  });
});
