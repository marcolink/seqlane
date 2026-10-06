import { z } from "zod";
import {
  reviewMetadataV5Schema,
  reviewStateV5Schema,
  reviewDecimalIdSchema,
  reviewDigestSchema,
  reviewPositiveIntegerSchema,
} from "@seqlane/code-review-workflow/contracts";
import { gitRevisionSchema } from "./contracts.js";
import { selectReviewAuthority } from "./review-report-authority.js";
import { decodeReviewStateV5 } from "./review-state-codec.js";
import { reviewSha256 } from "./review-state-canonical.js";

const markerIdentitySchema = z.object({
  schemaVersion: z.number().int().positive().safe(),
  pullRequestNumber: reviewPositiveIntegerSchema,
  reviewedRevision: gitRevisionSchema,
});

const reportContextSchema = z.strictObject({
  repositoryId: reviewDecimalIdSchema,
  pullRequestNumber: reviewPositiveIntegerSchema,
});
export const reviewReportClassificationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absent") }),
  z.strictObject({
    kind: z.literal("legacy"),
    reportId: reviewDecimalIdSchema,
    legacyMarker: z.strictObject({
      schemaVersion: z.number().int().positive().max(4),
      markerDigest: reviewDigestSchema,
    }),
  }),
  z.strictObject({
    kind: z.literal("current"),
    reportId: reviewDecimalIdSchema,
    state: reviewStateV5Schema,
    metadata: reviewMetadataV5Schema,
  }),
  z.strictObject({
    kind: z.literal("invalid-current"),
    reportId: reviewDecimalIdSchema,
    cause: z.unknown(),
  }),
]);
export type ReviewReportClassification = z.infer<
  typeof reviewReportClassificationSchema
>;

function readMarkerIdentity(body: string, pullRequestNumber: number) {
  const markers = [
    ...body.matchAll(/<!-- seqlane-code-review-meta-v(\d+): ([^\r\n]+) -->/g),
  ];
  const marker = markers[0];
  if (
    marker === undefined ||
    markers.length !== 1 ||
    body.split("<!-- seqlane-code-review-meta-").length !== 2
  )
    throw new Error("Expected one exact metadata marker");
  const value: unknown = JSON.parse(z.string().parse(marker[2]));
  const identity = markerIdentitySchema.parse(value);
  if (
    String(identity.schemaVersion) !== marker[1] ||
    identity.pullRequestNumber !== pullRequestNumber
  )
    throw new Error("Metadata identity mismatch");
  return { ...identity, markerText: marker[0] };
}

export async function classifyReviewReport(
  history: unknown,
  contextValue: unknown,
  options: {
    readonly botAuthors?: readonly string[];
    readonly signal?: AbortSignal;
  } = {},
): Promise<ReviewReportClassification> {
  const context = reportContextSchema.parse(contextValue);
  const report = selectReviewAuthority(history, options.botAuthors);
  if (report === undefined) return { kind: "absent" as const };
  try {
    const identity = readMarkerIdentity(report.body, context.pullRequestNumber);
    if (identity.schemaVersion < 5) {
      const stateMarkers = [
        ...report.body.matchAll(
          /<!-- seqlane-code-review-state-v(\d+)(?:-|:)/g,
        ),
      ];
      if (
        stateMarkers.some(
          (stateMarker) => stateMarker[1] !== String(identity.schemaVersion),
        )
      )
        throw new Error("Conflicting legacy transport version");
      return {
        kind: "legacy" as const,
        reportId: report.id,
        legacyMarker: {
          schemaVersion: identity.schemaVersion,
          markerDigest: reviewSha256(identity.markerText),
        },
      };
    }
    if (identity.schemaVersion !== 5)
      throw new Error("Unsupported future review state");
    const { state, metadata } = await decodeReviewStateV5(
      report.body,
      options.signal,
    );
    if (state.repositoryId !== context.repositoryId)
      throw new Error("Review state belongs to another repository");
    return reviewReportClassificationSchema.parse({
      kind: "current",
      reportId: report.id,
      state,
      metadata,
    });
  } catch (cause) {
    options.signal?.throwIfAborted();
    return { kind: "invalid-current" as const, reportId: report.id, cause };
  }
}
