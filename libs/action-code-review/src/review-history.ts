import { gunzipSync } from "node:zlib";
import { defineAgentTask, defineTask } from "@seqlane/core";
import { z } from "zod";
import {
  EMPTY_RUN_METRICS_LEDGER,
  findingIdentityKey,
  reviewCommentMetadataSchema,
  reviewCommentSchema,
  reviewDispositionActionSchema,
  reviewDispositionSchema,
  reviewHistoryInputSchema,
  reviewHistoryOutputSchema,
  reviewHistoryVerificationOutputSchema,
  reviewEvidenceContextSchema,
  reviewSnapshotSchema,
  reviewStateEnvelopeSchema,
  reviewStateSchema,
  reviewSeveritySchema,
  reviewRunMetricsLedgerSchema,
} from "./review-contracts.js";
import {
  gitEvidenceInstructions,
  sharedReviewTaskInstructions,
} from "./review-policy.js";

const MAX_REVIEW_DISPOSITIONS = 200;
const MAX_REVIEW_CONTEXT_COMMENT_BODY = 2_000;
const MAX_REVIEW_SNAPSHOT_DECOMPRESSED_BYTES = 512_000;
const TRUSTED_REVIEW_BOT_AUTHORS = new Set([
  "github-actions",
  "github-actions[bot]",
]);
const AUTHORIZED_REVIEW_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

function renderPromptData(label: string, value: unknown): string {
  return [
    `--- ${label} (untrusted review data) ---`,
    JSON.stringify(value) ?? "null",
    `--- End ${label} ---`,
  ].join("\n");
}

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
): z.infer<typeof reviewRunMetricsLedgerSchema> {
  if (comment === undefined || !isReviewReportComment(comment)) {
    return EMPTY_RUN_METRICS_LEDGER;
  }
  const blocks = [
    ...comment.body.matchAll(
      /<!-- seqlane-code-review-run-metrics-v1-start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- seqlane-code-review-run-metrics-v1-end -->/g,
    ),
  ];
  if (blocks.length !== 1) return EMPTY_RUN_METRICS_LEDGER;
  try {
    const value: unknown = JSON.parse(blocks[0]![1]!);
    const parsed = reviewRunMetricsLedgerSchema.safeParse(value);
    return parsed.success ? parsed.data : EMPTY_RUN_METRICS_LEDGER;
  } catch {
    return EMPTY_RUN_METRICS_LEDGER;
  }
}

function parseReviewSnapshot(
  comment: z.infer<typeof reviewCommentSchema> | undefined,
): z.infer<typeof reviewSnapshotSchema> | undefined {
  if (comment === undefined || !isReviewReportComment(comment))
    return undefined;
  const compressedMarker = comment.body.match(
    /<!-- seqlane-code-review-report-v2: ([A-Za-z0-9+/=]+) -->/,
  );
  const legacyMarker = comment.body.match(
    /<!-- seqlane-code-review-report-v1: ([A-Za-z0-9+/=]+) -->/,
  );
  const marker = compressedMarker ?? legacyMarker;
  if (marker === null) return undefined;

  try {
    const encoded = Buffer.from(marker[1]!, "base64");
    const decodedText =
      compressedMarker !== null
        ? gunzipSync(encoded, {
            maxOutputLength: MAX_REVIEW_SNAPSHOT_DECOMPRESSED_BYTES,
          }).toString("utf8")
        : encoded.toString("utf8");
    const decoded: unknown = JSON.parse(decodedText);
    const parsed = reviewSnapshotSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseReviewState(
  comment: z.infer<typeof reviewCommentSchema> | undefined,
): z.infer<typeof reviewStateSchema> | undefined {
  if (comment === undefined || !isReviewReportComment(comment))
    return undefined;
  const stateBlocks = [
    ...comment.body.matchAll(
      /<!-- seqlane-code-review-state-v3-start -->\s*```json\s*([^\r\n]+)\s*```\s*<!-- seqlane-code-review-state-v3-end -->/g,
    ),
  ];
  const metadataMarkers = [
    ...comment.body.matchAll(
      /<!-- seqlane-code-review-meta-v3: ([^\r\n]+) -->/g,
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
      maxOutputLength: MAX_REVIEW_SNAPSHOT_DECOMPRESSED_BYTES,
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

function parseReviewDispositionCommands(
  comment: z.infer<typeof reviewCommentSchema>,
): Array<z.infer<typeof reviewDispositionSchema>> {
  const dispositions: Array<z.infer<typeof reviewDispositionSchema>> = [];
  const authorized = AUTHORIZED_REVIEW_ASSOCIATIONS.has(
    comment.authorAssociation,
  );

  for (const line of comment.body.split(/\r?\n/)) {
    const match = line.match(
      /^\s*\/seqlane\s+(fixed|wont-fix|downgrade)\s+((?:F-[A-Za-z0-9][A-Za-z0-9_-]{0,63}|SEQ-PR[1-9]\d*-\d{3,}))(?:\s+(.*))?\s*$/i,
    );
    if (match === null) continue;

    const action = match[1]!.toLowerCase() as z.infer<
      typeof reviewDispositionActionSchema
    >;
    const remainder = match[3]?.trim();
    let effectiveSeverity: z.infer<typeof reviewSeveritySchema> | undefined;
    let reason = remainder;

    if (action === "downgrade") {
      const downgrade = remainder?.match(
        /^(?:to\s+)?(critical|required|optional|nit)(?:\s+(?:reason\s*[:=]\s*)?(.*))?$/i,
      );
      if (downgrade === undefined || downgrade === null) continue;
      effectiveSeverity = downgrade[1]!.toLowerCase() as z.infer<
        typeof reviewSeveritySchema
      >;
      reason = downgrade[2]?.trim();
    } else if (reason?.toLowerCase().startsWith("reason:")) {
      reason = reason.slice("reason:".length).trim();
    } else if (reason?.toLowerCase().startsWith("reason=")) {
      reason = reason.slice("reason=".length).trim();
    }

    const parsed = reviewDispositionSchema.safeParse({
      findingId: match[2]!,
      action,
      ...(effectiveSeverity === undefined ? {} : { effectiveSeverity }),
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
      commentId: comment.id,
      author: comment.author,
      authorAssociation: comment.authorAssociation,
      authorized,
      createdAt: comment.createdAt,
      effectiveAt: effectiveCommentTime(comment),
      ...(comment.commitId === undefined ? {} : { commitId: comment.commitId }),
    });
    if (parsed.success) dispositions.push(parsed.data);
  }

  return dispositions;
}

function parseOmittedReviewDispositionCommands(
  comment: z.infer<typeof reviewCommentSchema>,
): Array<z.infer<typeof reviewDispositionSchema>> {
  const authorized = AUTHORIZED_REVIEW_ASSOCIATIONS.has(
    comment.authorAssociation,
  );
  return (comment.omittedDispositionCommands ?? []).flatMap((command) => {
    const parsed = reviewDispositionSchema.safeParse({
      findingId: command.findingId,
      action: command.action,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
      ...(command.effectiveSeverity === undefined
        ? {}
        : { effectiveSeverity: command.effectiveSeverity }),
      commentId: comment.id,
      author: comment.author,
      authorAssociation: comment.authorAssociation,
      authorized,
      createdAt: comment.createdAt,
      effectiveAt: effectiveCommentTime(comment),
      ...(comment.commitId === undefined ? {} : { commitId: comment.commitId }),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function collectReviewDispositions(
  comments: readonly z.infer<typeof reviewCommentSchema>[],
  dispositions: readonly z.infer<typeof reviewDispositionSchema>[],
): Array<z.infer<typeof reviewDispositionSchema>> {
  return [
    ...dispositions,
    ...comments.flatMap(parseOmittedReviewDispositionCommands),
  ];
}

const reviewContextInputSchema = z.object({
  pullRequestNumber: z.number().int().positive(),
  reviewHistory: reviewHistoryInputSchema.optional(),
});

export const reviewContextTask = defineTask({
  id: "pr-code-review.review-context",
  input: reviewContextInputSchema,
  output: reviewHistoryOutputSchema,
  execute: async ({ input: { pullRequestNumber, reviewHistory } }) => {
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
    const previousSnapshot =
      previousState === undefined
        ? parseReviewSnapshot(previousReport)
        : undefined;
    const runMetricsLedger = parseReviewRunMetricsLedger(previousReport);
    const commentDispositions = new Map(
      comments.map((comment) => [
        comment.id,
        parseReviewDispositionCommands(comment),
      ]),
    );
    const latestDispositionByFindingAndAuthorization = new Map<
      string,
      z.infer<typeof reviewDispositionSchema>
    >();
    for (const disposition of collectReviewDispositions(
      comments,
      [...commentDispositions.values()].flat(),
    )) {
      const key = `${findingIdentityKey(disposition.findingId)}:${disposition.authorized ? "authorized" : "unauthorized"}`;
      const existing = latestDispositionByFindingAndAuthorization.get(key);
      if (
        existing === undefined ||
        existing.effectiveAt.localeCompare(disposition.effectiveAt) < 0 ||
        (existing.effectiveAt === disposition.effectiveAt &&
          existing.commentId.localeCompare(disposition.commentId) <= 0)
      ) {
        latestDispositionByFindingAndAuthorization.set(key, disposition);
      }
    }
    const allLatestDispositions = [
      ...latestDispositionByFindingAndAuthorization.values(),
    ].sort(
      (left, right) =>
        left.effectiveAt.localeCompare(right.effectiveAt) ||
        left.commentId.localeCompare(right.commentId),
    );
    const retainedFindings =
      previousState?.findings ?? previousSnapshot?.findings ?? [];
    const retainedDispositions = retainedFindings.flatMap((finding) => {
      const identities = new Set([
        findingIdentityKey(finding.id),
        ...("aliases" in finding && Array.isArray(finding.aliases)
          ? finding.aliases
              .filter((alias): alias is string => typeof alias === "string")
              .map(findingIdentityKey)
          : []),
      ]);
      const latest = allLatestDispositions
        .filter(
          (disposition) =>
            disposition.authorized &&
            identities.has(findingIdentityKey(disposition.findingId)),
        )
        .at(-1);
      return latest === undefined ? [] : [latest];
    });
    const retainedDispositionKeys = new Set(
      retainedDispositions.map(
        (disposition) =>
          `${findingIdentityKey(disposition.findingId)}:${disposition.authorized ? "authorized" : "unauthorized"}`,
      ),
    );
    const remainingDispositionCapacity = Math.max(
      0,
      MAX_REVIEW_DISPOSITIONS - retainedDispositions.length,
    );
    const otherDispositions = allLatestDispositions.filter(
      (disposition) =>
        !retainedDispositionKeys.has(
          `${findingIdentityKey(disposition.findingId)}:${disposition.authorized ? "authorized" : "unauthorized"}`,
        ),
    );
    const dispositions = [
      ...retainedDispositions,
      ...otherDispositions.slice(-remainingDispositionCapacity),
    ].sort(
      (left, right) =>
        left.effectiveAt.localeCompare(right.effectiveAt) ||
        left.commentId.localeCompare(right.commentId),
    );
    const dispositionsTruncated =
      dispositions.length < allLatestDispositions.length;
    const previousDispositionCommentIds = new Set(
      (previousState?.findings ?? previousSnapshot?.findings)?.flatMap(
        (finding) =>
          finding.dispositionCommentId === undefined
            ? []
            : [finding.dispositionCommentId],
      ) ?? [],
    );
    const relevantComments = comments.filter(
      (comment) =>
        comment.id === previousReport?.id ||
        (commentDispositions.get(comment.id)?.length ?? 0) > 0 ||
        (comment.omittedDispositionCommands?.length ?? 0) > 0 ||
        comment.omittedDispositionCommandsTruncated === true ||
        previousDispositionCommentIds.has(comment.id),
    );

    return {
      comments: relevantComments.map(compactReviewComment),
      commentIds: comments.map((comment) => comment.id),
      truncated:
        normalizedReviewHistory.truncated ||
        comments.some((comment) => comment.bodyTruncated === true) ||
        comments.some(
          (comment) => comment.omittedDispositionCommandsTruncated === true,
        ) ||
        dispositionsTruncated,
      dispositionsTruncated,
      ...(previousReport === undefined
        ? {}
        : { previousReport: compactReviewComment(previousReport) }),
      ...(previousState === undefined ? {} : { previousState }),
      ...(previousSnapshot === undefined ? {} : { previousSnapshot }),
      ...(previousState?.reviewedRevision === undefined &&
      previousSnapshot?.headRevision === undefined
        ? {}
        : {
            previousReviewedRevision:
              previousState?.reviewedRevision ?? previousSnapshot?.headRevision,
          }),
      dispositions,
      runMetricsLedger,
    };
  },
});

export const reviewHistoryVerificationTask = defineAgentTask({
  id: "pr-code-review.verify-history",
  input: z.object({ review: reviewEvidenceContextSchema }),
  output: reviewHistoryVerificationOutputSchema,
  goal: ({ review }) =>
    [
      `Verify previous Seqlane findings against the current pull-request head ${review.headRevision}.`,
      renderPromptData("Review history and current Git evidence", review),
    ].join("\n"),
  instructions: [
    ...sharedReviewTaskInstructions,
    "This task runs before the three specialist review lanes. Verify each retained previous finding independently against current-head evidence.",
    ...gitEvidenceInstructions,
    "Use present when the problem still exists. Use addressed when the patch appears intended to fix it but the available evidence is insufficient. Use resolved only when finding-specific current-head evidence demonstrates that the problem no longer exists. Use uncertain when bounded evidence cannot decide.",
    "A human fixed command is a claim, not proof. Never mark a finding resolved only because a comment, previous report, or synthesis says it is fixed.",
    "Copy review.headRevision exactly into the output and into every finding verification. Return at most one verification per retained finding ID.",
    "Record evidence that is specific enough to audit. Include a workspace-relative file and line when available.",
    "If no trusted previous state or legacy snapshot exists, return an empty verification list.",
    "Return only the structured current-head history verification.",
  ],
  observability: {
    studio: {
      result: { includePaths: ["/verifications", "/limitations"] },
    },
  },
});

export {
  collectReviewDispositions,
  effectiveCommentTime,
  isReviewReportComment,
  parseReviewState,
  renderPromptData,
};
