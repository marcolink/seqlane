import type { PublicationSnapshot } from "./publication-contracts.js";
import { deriveRunMetrics, type ReviewRunMetrics } from "./metrics.js";

export function derivePublicationMetrics(
  snapshot: PublicationSnapshot,
): ReviewRunMetrics {
  return deriveRunMetrics(snapshot.events, snapshot.runId);
}
