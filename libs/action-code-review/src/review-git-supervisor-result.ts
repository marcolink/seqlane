import { z } from "zod";
import { reviewGitResultSchema } from "./review-git-budget.js";
import {
  ReviewScopeError,
  ReviewScopeLimitError,
} from "./review-scope-errors.js";

const base64Bytes = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .transform((value, context) => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) {
      context.addIssue({
        code: "custom",
        message: "Noncanonical supervisor bytes",
      });
      return z.NEVER;
    }
    return bytes;
  });
const supervisorResultSchema = z.discriminatedUnion("kind", [
  reviewGitResultSchema
    .omit({ stdoutTruncated: true, stderrTruncated: true })
    .extend({
      kind: z.literal("ok"),
      stdout: base64Bytes,
      stderr: base64Bytes,
    }),
  z.strictObject({
    kind: z.literal("limit"),
    resource: z.enum([
      "commandWallMs",
      "commandCpuMs",
      "peakMemoryBytes",
      "outputBytes",
    ]),
    observed: z.number().finite().nonnegative(),
    limit: z.number().finite().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("cancelled") }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.literal("GIT_SUPERVISOR_FAILED"),
  }),
]);

export function parseReviewGitSupervisorResult(
  bytes: Uint8Array,
  operation: string,
  signal?: AbortSignal,
) {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const result = supervisorResultSchema.parse(value);
    if (result.kind === "limit")
      throw new ReviewScopeLimitError(
        result.resource,
        result.observed,
        result.limit,
        operation,
      );
    if (result.kind === "cancelled" || signal?.aborted) {
      throw new ReviewScopeError(
        "REVIEW_SCOPE_CANCELLED",
        "Review Git work was cancelled.",
        signal?.reason,
      );
    }
    if (result.kind === "error")
      throw new ReviewScopeError(
        result.code,
        "Git controls, accounting, or cleanup failed.",
      );
    return reviewGitResultSchema.parse({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      usage: result.usage,
    });
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      "GIT_SUPERVISOR_OUTPUT",
      "The Git supervisor returned malformed accounting or output.",
      cause,
    );
  }
}
