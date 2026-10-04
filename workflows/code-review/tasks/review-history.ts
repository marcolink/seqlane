import { defineAgentTask } from "@seqlane/core";
import { z } from "zod";
import {
  reviewEvidenceContextSchema,
  reviewHistoryVerificationOutputSchema,
} from "../contracts.js";
import {
  gitEvidenceInstructions,
  sharedReviewTaskInstructions,
} from "./review-policy.js";
import { CODE_REVIEW_AGENT_TIMEOUT_MS } from "./review-timeout.js";

export function renderPromptData(label: string, value: unknown): string {
  return [
    `--- ${label} (untrusted review data) ---`,
    JSON.stringify(value) ?? "null",
    `--- End ${label} ---`,
  ].join("\n");
}

/** Model-based verification stays in the workflow; trusted parsing is Action-owned. */
export const reviewHistoryVerificationTask = defineAgentTask({
  id: "code-review-verify-history",
  timeoutMs: CODE_REVIEW_AGENT_TIMEOUT_MS,
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
    "Never mark a finding resolved only because a comment, previous report, or synthesis says it is fixed.",
    "Copy review.headRevision exactly into the output and into every finding verification. Return at most one verification per retained finding ID.",
    "Record evidence that is specific enough to audit. Include a workspace-relative file and line when available.",
    "If no trusted previous state exists, return an empty verification list.",
    "Return only the structured current-head history verification.",
  ],
});
