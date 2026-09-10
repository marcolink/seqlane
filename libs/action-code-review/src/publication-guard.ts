import {
  reviewPublicationMetadataSchema,
  type ReviewComment,
} from "./contracts.js";

const BOT_AUTHORS = new Set(["github-actions", "github-actions[bot]"]);
const METADATA_PATTERN = /<!-- seqlane-code-review-meta-v3: ([^\r\n]+) -->/g;

export interface PublicationGuardInput {
  readonly pullRequestNumber: number;
  readonly expectedHeadRevision: string;
  readonly workflowRunId: string;
  readonly githubRunId: string;
  readonly attempt: number;
}

export type PublicationGuardResult =
  | { readonly status: "stale" }
  | { readonly status: "eligible"; readonly report: ReviewComment };

function compareRunIds(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, "") || "0";
  const normalizedRight = right.replace(/^0+/, "") || "0";
  return normalizedLeft.length === normalizedRight.length
    ? normalizedLeft.localeCompare(normalizedRight)
    : normalizedLeft.length - normalizedRight.length;
}

export function readPublicationIdentity(body: string) {
  const matches = [...body.matchAll(METADATA_PATTERN)];
  if (matches.length !== 1) return undefined;
  try {
    const parsed = reviewPublicationMetadataSchema.safeParse(
      JSON.parse(matches[0]![1]!),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function guardPublicationTarget(
  report: ReviewComment | undefined,
  input: PublicationGuardInput,
): PublicationGuardResult | { readonly status: "create" } {
  if (report === undefined) return { status: "create" };
  if (
    !BOT_AUTHORS.has(report.author) ||
    !report.body.includes("<!-- seqlane-code-review -->")
  ) {
    return { status: "stale" };
  }
  const identity = readPublicationIdentity(report.body);
  if (
    identity === undefined ||
    identity.pullRequestNumber !== input.pullRequestNumber
  ) {
    return { status: "stale" };
  }
  const markerMatch = report.body.match(
    /<!-- seqlane-review-in-progress-run: ([^\r\n]+) -->/,
  );
  if (markerMatch !== null && markerMatch[1] !== input.workflowRunId)
    return { status: "stale" };
  if (identity.reviewedRevision === input.expectedHeadRevision) {
    const runOrder = compareRunIds(identity.run.id, input.githubRunId);
    if (
      runOrder > 0 ||
      (runOrder === 0 && identity.run.attempt > input.attempt)
    )
      return { status: "stale" };
  }
  return { status: "eligible", report };
}
