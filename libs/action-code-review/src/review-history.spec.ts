import { describe, expect, it } from "vitest";
import { normalizeReviewHistory } from "./review-history.js";

const revision = "a".repeat(40);

describe("normalizeReviewHistory", () => {
  it("keeps trusted history separate from the Action-owned metrics ledger", () => {
    const history = normalizeReviewHistory(125, {
      comments: [
        {
          id: "report",
          kind: "issue",
          author: "github-actions[bot]",
          authorAssociation: "NONE",
          createdAt: "2026-09-17T00:00:00Z",
          body: [
            "<!-- seqlane-code-review -->",
            "<!-- seqlane-code-review-run-metrics-v1-start -->",
            "```json",
            JSON.stringify({ schemaVersion: 1, runs: [] }),
            "```",
            "<!-- seqlane-code-review-run-metrics-v1-end -->",
          ].join("\n"),
        },
        {
          id: "command",
          kind: "issue",
          author: "maintainer",
          authorAssociation: "MEMBER",
          createdAt: "2026-09-17T00:01:00Z",
          body: "/seqlane fixed SEQ-PR125-010",
          commitId: revision,
        },
      ],
      truncated: false,
    });

    expect(history.reviewHistory).not.toHaveProperty("dispositions");
    expect(history.reviewHistory.comments.map((comment) => comment.id)).toEqual(
      ["report"],
    );
    expect(history.reviewHistory).not.toHaveProperty("runMetricsLedger");
    expect(history.runMetricsLedger).toEqual({ schemaVersion: 1, runs: [] });
  });

  it("drops malformed ledgers without discarding valid history", () => {
    const history = normalizeReviewHistory(125, {
      comments: [
        {
          id: "report",
          kind: "issue",
          author: "github-actions",
          authorAssociation: "NONE",
          createdAt: "2026-09-17T00:00:00Z",
          body: "<!-- seqlane-code-review -->\n<!-- seqlane-code-review-run-metrics-v1-start -->\n```json\nnope\n```\n<!-- seqlane-code-review-run-metrics-v1-end -->",
        },
      ],
      truncated: false,
    });

    expect(history.reviewHistory.previousReport?.id).toBe("report");
    expect(history.runMetricsLedger).toEqual({ schemaVersion: 1, runs: [] });
  });
});
