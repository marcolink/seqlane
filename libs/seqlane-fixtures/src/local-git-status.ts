import { createFlow, defineAgentTask, defineShellTask } from "@seqlane/core";
import { z } from "zod";

const inputSchema = z.object({});

export const gitStatusOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

const summaryOutputSchema = z.object({
  summary: z.string(),
});

export const localGitStatusTask = defineShellTask({
  id: "fixture.local-git-status",
  input: inputSchema,
  executable: "git",
  argv: () => ["status", "--porcelain=v1"],
});

export const summarizeGitStatusTask = defineAgentTask({
  id: "fixture.summarize-git-status",
  input: gitStatusOutputSchema,
  output: summaryOutputSchema,
  goal: ({ exitCode, stdout, stderr }) =>
    `Summarize this Git status data. Exit code: ${exitCode}. Stdout: ${JSON.stringify(stdout)}. Stderr: ${JSON.stringify(stderr)}.`,
});

export const localGitStatusWorkflow = createFlow({
  id: "local-git-status",
  input: inputSchema,
  output: summaryOutputSchema,
})
  .task("status", localGitStatusTask, ({ input }) => input, {
    workspace: "shared",
  })
  .task("summary", summarizeGitStatusTask, ({ tasks }) => tasks.status.output, {
    workspace: "shared",
  })
  .output(({ tasks }) => tasks.summary.output)
  .define();
