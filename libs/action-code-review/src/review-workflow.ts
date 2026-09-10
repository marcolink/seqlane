import { createFlow, isolated } from "@seqlane/core";
import { openai } from "@seqlane/core/models";
import {
  codeReviewInputSchema,
  codeReviewReportSchema,
} from "./review-contracts.js";
import { gitReviewEvidenceTask } from "./review-git-evidence.js";
import {
  reviewContextTask,
  reviewHistoryVerificationTask,
} from "./review-history.js";
import {
  correctnessReviewTask,
  maintainabilityReviewTask,
  riskReviewTask,
} from "./review-lanes.js";
import { synthesizeReviewTask } from "./review-synthesis.js";
import { applyReviewDispositionTask } from "./review-finalization.js";

export default createFlow({
  id: "pull-request-code-review",
  input: codeReviewInputSchema,
  output: codeReviewReportSchema,
})
  .task(
    "reviewContext",
    reviewContextTask,
    ({ input }) => ({
      pullRequestNumber: input.pullRequest.number,
      reviewHistory: input.reviewHistory,
    }),
    { workspace: "shared" },
  )
  .task(
    "gitEvidence",
    gitReviewEvidenceTask,
    ({ input, tasks }) => ({
      repository: input.repository,
      baseBranch: input.baseBranch,
      baseRevision: input.baseRevision,
      headRevision: input.headRevision,
      pullRequest: input.pullRequest,
      reviewHistory: input.reviewHistory,
      normalizedReviewHistory: tasks.reviewContext.output,
    }),
    { workspace: "shared" },
  )
  .task(
    "historyVerification",
    reviewHistoryVerificationTask,
    ({ input, tasks }) => ({
      review: {
        repository: input.repository,
        baseBranch: input.baseBranch,
        baseRevision: input.baseRevision,
        headRevision: input.headRevision,
        pullRequest: input.pullRequest,
        gitEvidence: tasks.gitEvidence.output,
        reviewHistory: tasks.reviewContext.output,
      },
    }),
    {
      workspace: "shared",
      session: isolated({
        model: openai("gpt-5.6-luna"),
        reasoning: "high",
      }),
    },
  )
  .task(
    "correctness",
    correctnessReviewTask,
    ({ input, tasks }) => ({
      review: {
        repository: input.repository,
        baseBranch: input.baseBranch,
        baseRevision: input.baseRevision,
        headRevision: input.headRevision,
        pullRequest: input.pullRequest,
        gitEvidence: tasks.gitEvidence.output,
        reviewHistory: tasks.reviewContext.output,
        historyVerification: tasks.historyVerification.output,
      },
    }),
    {
      workspace: "shared",
      session: isolated({
        model: openai("gpt-5.6-luna"),
        reasoning: "high",
      }),
    },
  )
  .task(
    "maintainability",
    maintainabilityReviewTask,
    ({ input, tasks }) => ({
      review: {
        repository: input.repository,
        baseBranch: input.baseBranch,
        baseRevision: input.baseRevision,
        headRevision: input.headRevision,
        pullRequest: input.pullRequest,
        gitEvidence: tasks.gitEvidence.output,
        reviewHistory: tasks.reviewContext.output,
        historyVerification: tasks.historyVerification.output,
      },
    }),
    {
      workspace: "shared",
      session: isolated({
        model: openai("gpt-5.6-luna"),
        reasoning: "high",
      }),
    },
  )
  .task(
    "risk",
    riskReviewTask,
    ({ input, tasks }) => ({
      review: {
        repository: input.repository,
        baseBranch: input.baseBranch,
        baseRevision: input.baseRevision,
        headRevision: input.headRevision,
        pullRequest: input.pullRequest,
        gitEvidence: tasks.gitEvidence.output,
        reviewHistory: tasks.reviewContext.output,
        historyVerification: tasks.historyVerification.output,
      },
    }),
    {
      workspace: "shared",
      session: isolated({
        model: openai("gpt-5.6-luna"),
        reasoning: "high",
      }),
    },
  )
  .task(
    "summarize",
    synthesizeReviewTask,
    ({ input, tasks }) => ({
      review: {
        repository: input.repository,
        baseBranch: input.baseBranch,
        baseRevision: input.baseRevision,
        headRevision: input.headRevision,
        pullRequest: input.pullRequest,
        gitEvidence: tasks.gitEvidence.output,
        reviewHistory: tasks.reviewContext.output,
        historyVerification: tasks.historyVerification.output,
      },
      correctness: tasks.correctness.output,
      maintainability: tasks.maintainability.output,
      risk: tasks.risk.output,
    }),
    {
      workspace: "shared",
      session: isolated({
        model: openai("gpt-5.6-luna"),
        reasoning: "high",
      }),
    },
  )
  .task(
    "applyDispositions",
    applyReviewDispositionTask,
    ({ input, tasks }) => ({
      review: {
        repository: input.repository,
        baseBranch: input.baseBranch,
        baseRevision: input.baseRevision,
        headRevision: input.headRevision,
        pullRequest: input.pullRequest,
        gitEvidence: tasks.gitEvidence.output,
        reviewHistory: tasks.reviewContext.output,
        historyVerification: tasks.historyVerification.output,
      },
      report: tasks.summarize.output,
    }),
    { workspace: "shared" },
  )
  .output(({ tasks }) => tasks.applyDispositions.output)
  .define();
