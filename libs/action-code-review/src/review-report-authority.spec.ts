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
  it("reads every bounded page through the raw port", async () => {
    const listIssueComments = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ ...platformComment, id: 1, user: { login: "human" } }],
        hasNextPage: true,
      })
      .mockResolvedValueOnce({ items: [platformComment], hasNextPage: false });
    const history = await readReviewAuthority({ listIssueComments }, 112);
    expect(listIssueComments.mock.calls).toEqual([
      [112, 1],
      [112, 2],
    ]);
    expect(selectReviewAuthority(history)?.id).toBe("42");
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
