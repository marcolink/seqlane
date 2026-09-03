import { createFlow, defineTask } from "@seqlane/core";
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

export const localGitStatusTask = defineTask({
  id: "fixture.local-git-status",
  workspace: "shared",
  input: inputSchema,
  output: gitStatusOutputSchema,
  execute: async (_input, { exec }) =>
    exec({ command: "git", args: ["status", "--porcelain=v1"] }),
});

export const summarizeGitStatusTask = defineTask({
  id: "fixture.summarize-git-status",
  workspace: "shared",
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
  .task("status", localGitStatusTask, ({ input }) => input)
  .task("summary", summarizeGitStatusTask, ({ tasks }) => tasks.status.output)
  .output(({ tasks }) => tasks.summary.output)
  .define();
