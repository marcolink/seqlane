import {
  createFlow,
  defineAgentTask,
  defineShellTask,
  isolated,
  shellTaskResultSchema,
} from "@seqlane/core";
import { openai } from "@seqlane/core/models";
import { z } from "zod";

const branchSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

const inputSchema = z.object({ branch: branchSchema });

const diffSummarySchema = z.object({
  branch: z.string(),
  range: z.string(),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  summary: z.string().min(1),
});

const evidenceInputSchema = z.object({
  branch: branchSchema,
  evidence: shellTaskResultSchema,
});

const outputSchema = z.object({
  direct: diffSummarySchema,
  evidence: diffSummarySchema,
});

const summaryInstructions = [
  "Inspect exactly the latest commit represented by branch~1..branch.",
  "Return branch, range, file and line totals, and one concise semantic summary.",
  "Do not modify files and do not guess beyond the available Git evidence.",
];

const summarySession = () =>
  isolated({
    model: openai("gpt-5.6-luna"),
    reasoning: "high",
  });

const directSummaryTask = defineAgentTask({
  id: "git-diff-summary-example-direct-agent",
  input: inputSchema,
  output: diffSummarySchema,
  goal: ({ branch }) =>
    `Summarize the Git diff for the latest commit on ${branch}. Inspect ${branch}~1..${branch} in the workspace.`,
  instructions: summaryInstructions,
});

const collectDiffTask = defineShellTask({
  id: "git-diff-summary-example-collect-diff",
  input: inputSchema,
  executable: "git",
  argv: ({ branch }) => [
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--patch",
    "--stat",
    "--unified=3",
    `${branch}~1`,
    branch,
    "--",
  ],
});

const evidenceSummaryTask = defineAgentTask({
  id: "git-diff-summary-example-summarize-evidence",
  input: evidenceInputSchema,
  output: diffSummarySchema,
  goal: ({ branch, evidence }) =>
    `Summarize the Git diff for the latest commit on ${branch} using this direct Git evidence. Exit code: ${evidence.exitCode}. Stdout: ${JSON.stringify(evidence.stdout)}. Stderr: ${JSON.stringify(evidence.stderr)}.`,
  instructions: summaryInstructions,
});

export const gitDiffSummaryEvidenceLaneWorkflow = createFlow({
  id: "git-diff-summary-example-evidence-lane",
  input: inputSchema,
  output: diffSummarySchema,
})
  .task("collectDiff", collectDiffTask, ({ input }) => input, {
    workspace: "shared",
  })
  .task(
    "summarizeEvidence",
    evidenceSummaryTask,
    ({ input, tasks }) => ({
      branch: input.branch,
      evidence: tasks.collectDiff.output,
    }),
    {
      workspace: "shared",
      session: summarySession(),
    },
  )
  .output(({ tasks }) => tasks.summarizeEvidence.output)
  .define();

export default createFlow({
  id: "git-diff-summary-example",
  input: inputSchema,
  output: outputSchema,
})
  .task("direct", directSummaryTask, ({ input }) => input, {
    workspace: "shared",
    session: summarySession(),
  })
  .task("evidence", gitDiffSummaryEvidenceLaneWorkflow, ({ input }) => input, {
    workspace: "shared",
  })
  .output(({ tasks }) => ({
    direct: tasks.direct.output,
    evidence: tasks.evidence.output,
  }))
  .define();
