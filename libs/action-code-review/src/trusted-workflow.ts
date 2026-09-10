/**
 * Compatibility export for callers that used the initial Action entry point.
 * The implementation lives in review-workflow.ts and contains the complete
 * deterministic context, evidence, verification, synthesis, and finalization
 * task graph.
 */
export { default } from "./review-workflow.js";
export { default as trustedCodeReviewWorkflow } from "./review-workflow.js";
