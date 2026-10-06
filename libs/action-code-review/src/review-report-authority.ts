import { z } from "zod";
import {
  reviewDecimalIdSchema,
  reviewPositiveIntegerSchema,
} from "@seqlane/code-review-workflow/contracts";
import { reviewHistorySchema, type ReviewHistory } from "./contracts.js";
import type { GitHubReviewClient } from "./github-port.js";
import { ReviewScopeError } from "./review-scope-errors.js";

export const REVIEW_REPORT_MARKER = "<!-- seqlane-code-review -->";
export const DEFAULT_REVIEW_BOT_AUTHORS = Object.freeze([
  "github-actions",
  "github-actions[bot]",
]);
const platformId = z
  .union([reviewDecimalIdSchema, reviewPositiveIntegerSchema])
  .transform(String);
const platformCommentSchema = z.object({
  id: platformId,
  body: z.string().max(65_536),
  user: z.object({ login: z.string().min(1).max(256) }),
  author_association: z.string().min(1).max(64),
  created_at: z.string().min(1).max(64),
  updated_at: z.string().min(1).max(64),
});
const authorityPageSchema = z.strictObject({
  items: z.array(platformCommentSchema).max(100),
  hasNextPage: z.boolean(),
});
const botAuthorsSchema = z.array(z.string().min(1).max(256)).min(1).max(8);

/** Read-only raw GitHub boundary; pagination completeness is mandatory. */
export type ReviewAuthorityReadPort = Pick<
  GitHubReviewClient,
  "listIssueComments"
>;

export async function readReviewAuthority(
  port: ReviewAuthorityReadPort,
  pullRequestNumber: number,
): Promise<ReviewHistory> {
  try {
    reviewPositiveIntegerSchema.parse(pullRequestNumber);
    const comments: ReviewHistory["comments"] = [];
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
      const page = authorityPageSchema.parse(
        await port.listIssueComments(pullRequestNumber, pageNumber),
      );
      for (const comment of page.items) {
        comments.push({
          id: comment.id,
          kind: "issue",
          author: comment.user.login,
          authorAssociation: comment.author_association,
          body: comment.body,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
        });
      }
      if (!page.hasNextPage)
        return reviewHistorySchema.parse({ comments, truncated: false });
    }
    throw new ReviewScopeError(
      "REVIEW_AUTHORITY_INCOMPLETE",
      "Review comment lookup exceeded its complete inventory bound.",
    );
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      "REVIEW_AUTHORITY_READ_FAILED",
      "Could not read a complete review comment inventory.",
      cause,
    );
  }
}

export function selectReviewAuthority(
  historyValue: unknown,
  botAuthorsValue: unknown = DEFAULT_REVIEW_BOT_AUTHORS,
) {
  const history = reviewHistorySchema.parse(historyValue);
  const botAuthors = new Set(botAuthorsSchema.parse(botAuthorsValue));
  if (
    history.truncated ||
    history.comments.some((comment) => comment.bodyTruncated)
  ) {
    throw new ReviewScopeError(
      "REVIEW_AUTHORITY_INCOMPLETE",
      "Review comment inventory is incomplete.",
    );
  }
  if (
    new Set(history.comments.map((comment) => comment.id)).size !==
    history.comments.length
  ) {
    throw new ReviewScopeError(
      "REVIEW_AUTHORITY_AMBIGUOUS",
      "Review comment inventory contains duplicate identities.",
    );
  }
  const reports = history.comments.filter(
    (comment) =>
      comment.kind === "issue" &&
      botAuthors.has(comment.author) &&
      comment.body.includes(REVIEW_REPORT_MARKER),
  );
  if (reports.length > 1) {
    throw new ReviewScopeError(
      "REVIEW_AUTHORITY_AMBIGUOUS",
      "Multiple trusted review reports exist.",
    );
  }
  const report = reports[0];
  if (report !== undefined) {
    reviewDecimalIdSchema.parse(report.id);
    if (
      Buffer.byteLength(report.body, "utf8") > 65_536 ||
      report.body.split(REVIEW_REPORT_MARKER).length !== 2
    ) {
      throw new ReviewScopeError(
        "REVIEW_REPORT_INVALID",
        "Review report marker or byte bound is invalid.",
      );
    }
  }
  return report;
}
