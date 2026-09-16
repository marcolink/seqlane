import { defineTask } from "@seqlane/core";
import { z } from "zod";
import {
  EMPTY_RUN_METRICS_LEDGER,
  MAX_REVIEW_FINDINGS,
  REVIEW_SEVERITY_RANK,
  findingIdentityKey,
  isStableFindingId,
  stableFindingId,
  reviewContextSchema,
  reviewDispositionSchema,
  reviewFindingDispositionSchema,
  reviewFindingStatusSchema,
  reviewReportFindingSchema,
  reviewSnapshotFindingSchema,
  codeReviewReportSchema,
  synthesizedReviewReportSchema,
} from "../contracts.js";
import { collectReviewDispositions } from "./review-history.js";

const applyReviewDispositionInputSchema = z.object({
  review: reviewContextSchema,
  report: synthesizedReviewReportSchema,
});

type ReviewReportFinding = z.infer<typeof reviewReportFindingSchema>;

function clearDispositionMetadata(
  finding: ReviewReportFinding,
): ReviewReportFinding {
  const clean = { ...finding };
  delete clean.dispositionReason;
  delete clean.dispositionBy;
  delete clean.dispositionAt;
  delete clean.dispositionCommentId;
  delete clean.dispositionCommit;
  delete clean.evidenceHeadRevision;
  return clean;
}

function addDispositionMetadata(
  finding: ReviewReportFinding,
  disposition: z.infer<typeof reviewDispositionSchema>,
  nextDisposition: z.infer<typeof reviewFindingDispositionSchema>,
  status: z.infer<typeof reviewFindingStatusSchema>,
  effectiveSeverity = finding.effectiveSeverity,
): ReviewReportFinding {
  const clean = clearDispositionMetadata(finding);
  return {
    ...clean,
    effectiveSeverity,
    disposition: nextDisposition,
    status,
    ...(disposition.reason === undefined
      ? {}
      : { dispositionReason: disposition.reason }),
    dispositionBy: disposition.author,
    dispositionAt: disposition.effectiveAt,
    dispositionCommentId: disposition.commentId,
    ...(disposition.commitId === undefined
      ? {}
      : { dispositionCommit: disposition.commitId }),
  };
}

function openFinding(
  finding: ReviewReportFinding,
  status: z.infer<typeof reviewFindingStatusSchema>,
): ReviewReportFinding {
  const openFindingBase = clearDispositionMetadata(finding);
  return {
    ...openFindingBase,
    effectiveSeverity: finding.severity,
    disposition: "open",
    status,
  };
}

function findingMatchesId(finding: ReviewReportFinding, id: string): boolean {
  const identity = findingIdentityKey(id);
  return [finding.id, ...finding.aliases].some(
    (candidate) => findingIdentityKey(candidate) === identity,
  );
}

function legacyFindingStatus(
  finding: z.infer<typeof reviewSnapshotFindingSchema>,
): z.infer<typeof reviewFindingStatusSchema> {
  if (finding.disposition === "fixed") return "resolved";
  if (finding.disposition === "wont-fix") return "dismissed";
  return "open";
}

const applyReviewDispositionTask = defineTask({
  id: "code-review-apply-dispositions",
  input: applyReviewDispositionInputSchema,
  output: codeReviewReportSchema,
  execute: async ({ input: { review, report } }) => {
    const latestAuthorized = new Map<
      string,
      z.infer<typeof reviewDispositionSchema>
    >();
    for (const disposition of collectReviewDispositions(
      review.reviewHistory.comments,
      review.reviewHistory.dispositions,
    )) {
      if (!disposition.authorized) continue;
      const dispositionKey = findingIdentityKey(disposition.findingId);
      const existing = latestAuthorized.get(dispositionKey);
      if (
        existing === undefined ||
        existing.effectiveAt.localeCompare(disposition.effectiveAt) <= 0
      ) {
        latestAuthorized.set(dispositionKey, disposition);
      }
    }
    let nextFindingIndex =
      review.reviewHistory.previousState?.nextFindingIndex ?? 1;
    const allocateFindingId = () =>
      stableFindingId(review.pullRequest.number, nextFindingIndex++);
    const previousSource: ReviewReportFinding[] =
      review.reviewHistory.previousState?.findings.map((finding) => ({
        ...finding,
        aliases: [...finding.aliases],
      })) ??
      review.reviewHistory.previousSnapshot?.findings.map((finding) => ({
        ...finding,
        status: legacyFindingStatus(finding),
        aliases: [],
      })) ??
      [];
    const previousIdentities = new Set<string>();
    let duplicateHistoricalFindings = 0;
    const uniquePreviousSource = previousSource.filter((finding) => {
      const identities = [finding.id, ...finding.aliases].map(
        findingIdentityKey,
      );
      if (identities.some((identity) => previousIdentities.has(identity))) {
        duplicateHistoricalFindings++;
        return false;
      }
      for (const identity of identities) previousIdentities.add(identity);
      return true;
    });
    const previousFindings = uniquePreviousSource.map((finding) => {
      if (isStableFindingId(finding.id, review.pullRequest.number)) {
        const parsedIndex = Number(finding.id.split("-").at(-1));
        if (Number.isSafeInteger(parsedIndex)) {
          nextFindingIndex = Math.max(nextFindingIndex, parsedIndex + 1);
        }
        return finding;
      }
      return {
        ...finding,
        id: allocateFindingId(),
        aliases: [...new Set([...finding.aliases, finding.id])].slice(0, 8),
      };
    });

    const findPrevious = (id: string) =>
      previousFindings.find((finding) => findingMatchesId(finding, id));
    const dispositionFor = (finding: ReviewReportFinding) =>
      [finding.id, ...finding.aliases]
        .map((id) => latestAuthorized.get(findingIdentityKey(id)))
        .filter(
          (value): value is z.infer<typeof reviewDispositionSchema> =>
            value !== undefined,
        )
        .sort(
          (left, right) =>
            left.effectiveAt.localeCompare(right.effectiveAt) ||
            left.commentId.localeCompare(right.commentId),
        )
        .at(-1);
    const verifiedOutcomeFor = (finding: ReviewReportFinding) => {
      if (review.historyVerification.headRevision !== review.headRevision)
        return undefined;
      return review.historyVerification.verifications.find(
        (verification) =>
          verification.headRevision === review.headRevision &&
          findingMatchesId(finding, verification.findingId),
      )?.outcome;
    };
    const previousDispositionStillActive = (finding: ReviewReportFinding) => {
      if (finding.dispositionCommentId === undefined) return false;
      if (dispositionFor(finding)?.commentId === finding.dispositionCommentId)
        return true;
      const expectedAction =
        finding.disposition === "downgraded"
          ? "downgrade"
          : finding.disposition === "fixed" ||
              finding.disposition === "wont-fix"
            ? finding.disposition
            : undefined;
      if (
        expectedAction !== undefined &&
        review.reviewHistory.comments.some((comment) => {
          if (comment.id !== finding.dispositionCommentId) return false;
          return comment.omittedDispositionCommands?.some(
            (command) =>
              command.authorized &&
              command.action === expectedAction &&
              findingMatchesId(finding, command.findingId) &&
              (expectedAction !== "downgrade" ||
                command.effectiveSeverity === finding.effectiveSeverity),
          );
        })
      ) {
        return true;
      }
      return (
        review.reviewHistory.truncated &&
        !review.reviewHistory.commentIds.includes(finding.dispositionCommentId)
      );
    };
    const applyDisposition = (
      finding: ReviewReportFinding,
      status: z.infer<typeof reviewFindingStatusSchema>,
      disposition: z.infer<typeof reviewDispositionSchema> | undefined,
    ): ReviewReportFinding => {
      if (disposition?.action === "wont-fix") {
        return addDispositionMetadata(
          finding,
          disposition,
          "wont-fix",
          "dismissed",
          finding.severity,
        );
      }
      if (disposition?.action === "fixed") {
        return addDispositionMetadata(
          finding,
          disposition,
          "fixed",
          status === "resolved" ? "resolved" : "addressed",
        );
      }
      if (disposition?.action === "downgrade") {
        const effectiveSeverity = disposition.effectiveSeverity;
        if (
          effectiveSeverity !== undefined &&
          REVIEW_SEVERITY_RANK[effectiveSeverity] <
            REVIEW_SEVERITY_RANK[finding.severity]
        ) {
          return addDispositionMetadata(
            finding,
            disposition,
            "downgraded",
            status,
            effectiveSeverity,
          );
        }
      }
      return openFinding(finding, status);
    };

    const currentIds = new Set<string>();
    const currentSourceIds = new Set<string>();
    const findings: ReviewReportFinding[] = [];
    for (const synthesized of report.findings) {
      const previous = findPrevious(synthesized.id);
      const sourceId = previous?.id ?? synthesized.id;
      const sourceIdKey = findingIdentityKey(sourceId);
      if (currentSourceIds.has(sourceIdKey)) continue;
      currentSourceIds.add(sourceIdKey);
      const id = previous?.id ?? allocateFindingId();
      if (currentIds.has(id)) continue;
      currentIds.add(id);
      const aliases = [
        ...(previous?.aliases ?? []),
        ...(synthesized.id === id ? [] : [synthesized.id]),
      ];
      const current: ReviewReportFinding = {
        ...synthesized,
        id,
        severity: previous?.severity ?? synthesized.severity,
        effectiveSeverity: previous?.severity ?? synthesized.severity,
        disposition: "open",
        status:
          previous?.status === "resolved" || previous?.status === "dismissed"
            ? "reopened"
            : previous === undefined
              ? "new"
              : "open",
        aliases: [...new Set(aliases)].slice(0, 8),
      };
      findings.push(
        applyDisposition(current, current.status, dispositionFor(current)),
      );
    }

    for (const previous of previousFindings) {
      if (currentIds.has(previous.id)) continue;
      const disposition = dispositionFor(previous);
      const verifiedOutcome = verifiedOutcomeFor(previous);
      if (disposition !== undefined) {
        const status =
          verifiedOutcome === "resolved"
            ? "resolved"
            : verifiedOutcome === "present"
              ? "reopened"
              : verifiedOutcome === "addressed"
                ? "addressed"
                : previous.status === "resolved"
                  ? "reopened"
                  : previous.status;
        findings.push(applyDisposition(previous, status, disposition));
        continue;
      }
      if (
        previous.disposition !== "open" &&
        !previousDispositionStillActive(previous)
      ) {
        findings.push(openFinding(previous, "reopened"));
        continue;
      }
      if (
        verifiedOutcome === "present" &&
        previous.disposition !== "wont-fix"
      ) {
        findings.push(openFinding(previous, "reopened"));
        continue;
      }
      if (previousDispositionStillActive(previous)) {
        findings.push(
          previous.status === "resolved" && verifiedOutcome !== "resolved"
            ? {
                ...previous,
                status:
                  previous.disposition === "fixed" ? "addressed" : "reopened",
              }
            : previous,
        );
        continue;
      }
      if (verifiedOutcome === "resolved") {
        findings.push(openFinding(previous, "resolved"));
      } else if (verifiedOutcome === "present") {
        findings.push(openFinding(previous, "reopened"));
      } else if (verifiedOutcome === "addressed") {
        findings.push(openFinding(previous, "addressed"));
      } else if (previous.status === "resolved") {
        findings.push(openFinding(previous, "reopened"));
      } else if (previous.status === "dismissed") {
        findings.push(openFinding(previous, "open"));
      } else {
        findings.push(
          openFinding(
            previous,
            previous.status === "new" ? "open" : previous.status,
          ),
        );
      }
    }

    const findingsOverflow = Math.max(0, findings.length - MAX_REVIEW_FINDINGS);
    const boundedFindings = findings
      .map((finding, index) => ({
        finding,
        index,
        blocking:
          ["new", "open", "addressed", "reopened"].includes(finding.status) &&
          (finding.effectiveSeverity === "critical" ||
            finding.effectiveSeverity === "required"),
        current: currentIds.has(finding.id),
      }))
      .sort(
        (left, right) =>
          Number(right.blocking) - Number(left.blocking) ||
          Number(right.current) - Number(left.current) ||
          left.index - right.index,
      )
      .slice(0, MAX_REVIEW_FINDINGS)
      .sort((left, right) => left.index - right.index)
      .map(({ finding }) => finding);

    const verdict = boundedFindings.some(
      (finding) =>
        ["new", "open", "addressed", "reopened"].includes(finding.status) &&
        (finding.effectiveSeverity === "critical" ||
          finding.effectiveSeverity === "required"),
    )
      ? "request-changes"
      : "approve";
    const limitations: string[] = [];
    if (review.gitEvidence.patchTruncated) {
      limitations.push(
        "The patch was truncated; omitted hunks were not reviewed.",
      );
    }
    if (review.gitEvidence.changedFilesTruncated) {
      limitations.push("The changed-file list was truncated.");
    }
    if (review.gitEvidence.diffStatTruncated) {
      limitations.push("The diff summary was truncated.");
    }
    if (
      review.gitEvidence.diffCheck.stdoutTruncated ||
      review.gitEvidence.diffCheck.stderrTruncated
    ) {
      limitations.push("The whitespace-check output was truncated.");
    }
    if (review.reviewHistory.truncated) {
      limitations.push(
        "Review history was truncated; only bounded comment context was available.",
      );
    }
    if (review.reviewHistory.dispositionsTruncated) {
      limitations.push(
        "Disposition commands were truncated; only the bounded decision set was retained.",
      );
    }
    if (review.reviewHistory.previousSnapshot?.truncated) {
      limitations.push(
        "The previous Seqlane report snapshot was compacted; omitted historical text was not restored.",
      );
    }
    if (review.reviewHistory.previousState?.truncated) {
      limitations.push(
        "The previous Seqlane state was compacted; omitted historical detail was not restored.",
      );
    }
    if (
      review.gitEvidence.previousReviewedRevision !== undefined &&
      !review.gitEvidence.previousRevisionComparable
    ) {
      limitations.push(
        "The previous reviewed revision is not an ancestor of the current head; no revision delta is claimed.",
      );
    }
    if (findingsOverflow > 0) {
      limitations.push(
        `${findingsOverflow} lower-priority finding(s) were omitted because the report is bounded to ${MAX_REVIEW_FINDINGS} findings.`,
      );
    }
    if (duplicateHistoricalFindings > 0) {
      limitations.push(
        `${duplicateHistoricalFindings} duplicate historical finding(s) were omitted during state migration.`,
      );
    }
    limitations.push(...review.historyVerification.limitations);

    return {
      ...report,
      repository: review.repository,
      baseBranch: review.baseBranch,
      baseRevision: review.baseRevision,
      headRevision: review.headRevision,
      pullRequestNumber: review.pullRequest.number,
      ...(review.gitEvidence.previousRevisionComparable &&
      review.gitEvidence.previousReviewedRevision !== undefined
        ? {
            previousReviewedRevision:
              review.gitEvidence.previousReviewedRevision,
          }
        : {}),
      nextFindingIndex,
      verdict,
      findings: boundedFindings,
      limitations: [...new Set(limitations)].slice(0, 20),
      stateTruncated:
        findingsOverflow > 0 ||
        duplicateHistoricalFindings > 0 ||
        review.reviewHistory.previousState?.truncated === true ||
        review.reviewHistory.previousSnapshot?.truncated === true,
      runMetricsLedger:
        review.reviewHistory.runMetricsLedger ?? EMPTY_RUN_METRICS_LEDGER,
    };
  },
});

export { applyReviewDispositionTask };
