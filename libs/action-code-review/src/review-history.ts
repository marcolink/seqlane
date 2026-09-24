import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  reviewCommentMetadataSchema,
  reviewCommentSchema,
  reviewHistoryInputSchema,
  reviewHistoryOutputSchema,
  reviewStateEnvelopeSchema,
  reviewStateSchema,
} from "@seqlane/code-review-workflow/contracts";
import { EMPTY_LEDGER, ledgerSchema } from "./publication-contracts.js";

const MAX_REVIEW_CONTEXT_COMMENT_BODY = 2_000;
const MAX_REVIEW_STATE_DECOMPRESSED_BYTES = 512_000;
const TRUSTED_REVIEW_BOT_AUTHORS = new Set([
  "github-actions",
  "github-actions[bot]",
]);
function effectiveCommentTime(comment: z.infer<typeof reviewCommentSchema>) {
  return comment.updatedAt ?? comment.createdAt;
}

function isReviewReportComment(comment: z.infer<typeof reviewCommentSchema>) {
  return (
    TRUSTED_REVIEW_BOT_AUTHORS.has(comment.author) &&
    comment.body.includes("<!-- seqlane-code-review -->")
  );
}

function compactReviewComment(
  comment: z.infer<typeof reviewCommentSchema>,
): z.infer<typeof reviewCommentSchema> {
  return {
    ...comment,
    body: isReviewReportComment(comment)
      ? ""
      : comment.body.slice(0, MAX_REVIEW_CONTEXT_COMMENT_BODY),
  };
}

function parseReviewRunMetricsLedger(
  comment: z.infer<typeof reviewCommentSchema> | undefined,
): z.infer<typeof ledgerSchema> {
  if (comment === undefined || !isReviewReportComment(comment)) {
    return EMPTY_LEDGER;
  }
  const blocks = [
    ...comment.body.matchAll(
      /<!-- seqlane-code-review-run-metrics-v1-start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- seqlane-code-review-run-metrics-v1-end -->/g,
    ),
  ];
  if (blocks.length !== 1) return EMPTY_LEDGER;
  try {
    const value: unknown = JSON.parse(blocks[0]![1]!);
    const parsed = ledgerSchema.safeParse(value);
    return parsed.success ? parsed.data : EMPTY_LEDGER;
  } catch {
    return EMPTY_LEDGER;
  }
}

function parseReviewState(
  comment: z.infer<typeof reviewCommentSchema> | undefined,
): z.infer<typeof reviewStateSchema> | undefined {
  if (comment === undefined || !isReviewReportComment(comment))
    return undefined;
  const stateBlocks = [
    ...comment.body.matchAll(
      /<!-- seqlane-code-review-state-v4-start -->\s*```json\s*([^\r\n]+)\s*```\s*<!-- seqlane-code-review-state-v4-end -->/g,
    ),
  ];
  const metadataMarkers = [
    ...comment.body.matchAll(
      /<!-- seqlane-code-review-meta-v4: ([^\r\n]+) -->/g,
    ),
  ];
  if (stateBlocks.length !== 1 || metadataMarkers.length !== 1)
    return undefined;

  try {
    const metadataValue: unknown = JSON.parse(metadataMarkers[0]![1]!);
    const metadata = reviewCommentMetadataSchema.safeParse(metadataValue);
    if (!metadata.success) return undefined;
    const envelopeValue: unknown = JSON.parse(stateBlocks[0]![1]!);
    const envelope = reviewStateEnvelopeSchema.safeParse(envelopeValue);
    if (!envelope.success) return undefined;
    const decodedText = gunzipSync(Buffer.from(envelope.data.data, "base64"), {
      maxOutputLength: MAX_REVIEW_STATE_DECOMPRESSED_BYTES,
    }).toString("utf8");
    const decoded: unknown = JSON.parse(decodedText);
    const parsed = reviewStateSchema.safeParse(decoded);
    if (!parsed.success) return undefined;
    if (
      parsed.data.pullRequestNumber !== metadata.data.pullRequestNumber ||
      parsed.data.reviewedRevision !== metadata.data.reviewedRevision ||
      parsed.data.previousReviewedRevision !==
        metadata.data.previousReviewedRevision
    ) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

export function normalizeReviewHistory(
  pullRequestNumber: number,
  reviewHistory: z.input<typeof reviewHistoryInputSchema> | undefined,
): {
  readonly reviewHistory: z.output<typeof reviewHistoryOutputSchema>;
  readonly runMetricsLedger: z.infer<typeof ledgerSchema>;
} {
  const normalizedReviewHistory = reviewHistory ?? {
    comments: [],
    truncated: false,
  };
  const comments = [...normalizedReviewHistory.comments].sort(
    (left, right) =>
      effectiveCommentTime(left).localeCompare(effectiveCommentTime(right)) ||
      left.id.localeCompare(right.id),
  );
  const reportComments = comments.filter(isReviewReportComment);
  const previousReport = reportComments.at(-1);
  const parsedPreviousState = parseReviewState(previousReport);
  const previousState =
    parsedPreviousState?.pullRequestNumber === pullRequestNumber
      ? parsedPreviousState
      : undefined;
  const runMetricsLedger = parseReviewRunMetricsLedger(previousReport);
  const relevantComments = previousReport === undefined ? [] : [previousReport];

  return {
    reviewHistory: {
      comments: relevantComments.map(compactReviewComment),
      truncated:
        normalizedReviewHistory.truncated ||
        comments.some((comment) => comment.bodyTruncated === true),
      ...(previousReport === undefined
        ? {}
        : { previousReport: compactReviewComment(previousReport) }),
      ...(previousState === undefined ? {} : { previousState }),
      ...(previousState === undefined
        ? {}
        : { previousReviewedRevision: previousState.reviewedRevision }),
    },
    runMetricsLedger,
  };
}

export { effectiveCommentTime, isReviewReportComment, parseReviewState };
