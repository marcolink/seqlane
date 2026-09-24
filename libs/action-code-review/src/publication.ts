import {
  publicationSnapshotSchema,
  type DerivedPublication,
  type PublicationSnapshot,
  type PublicationSnapshotInput,
} from "./publication-contracts.js";
import {
  reviewPublicationSchema,
  type ReviewPublication,
} from "./contracts.js";
import type { ReviewRunMetrics } from "./metrics.js";
import { preparePublication } from "./publication-state.js";
import { fitPublicationBody } from "./publication-fitting.js";
import { derivePublicationMetrics } from "./publication-metrics.js";

export { publicationSnapshotSchema };
export type {
  DerivedPublication,
  PublicationSnapshot,
  PublicationSnapshotInput,
};
export { derivePublicationMetrics } from "./publication-metrics.js";

/** Deterministically renders one bounded v4 report from frozen review data. */
export function renderPublication(
  snapshot: PublicationSnapshot,
  metrics: ReviewRunMetrics,
): ReviewPublication {
  const prepared = preparePublication(snapshot, metrics);
  const { report, body } = fitPublicationBody(
    prepared.report,
    prepared.ledger,
    prepared.githubRunId,
    prepared.attempt,
  );
  return reviewPublicationSchema.parse({
    verdict: report.verdict,
    reviewedRevision: report.headRevision,
    body,
  });
}

/** Convenience API for callers that do not need the workflow stages. */
export function derivePublication(
  snapshot: PublicationSnapshot,
): DerivedPublication {
  const metrics = derivePublicationMetrics(snapshot);
  return { metrics, publication: renderPublication(snapshot, metrics) };
}
