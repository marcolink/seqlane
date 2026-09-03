import { createFlow, defineTask } from "@seqlane/core";
import { z } from "zod";

const inputSchema = z.object({});

const gitStatusOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

const summaryOutputSchema = z.object({
  summary: z.string(),
});

const localGitStatusTask = defineTask({
  id: "example.local-git-status",
  workspace: "shared",
  input: inputSchema,
  output: gitStatusOutputSchema,
  execute: async (_input, { exec }) =>
    exec({ command: "git", args: ["status", "--porcelain=v1"] }),
});

const summarizeGitStatusTask = defineTask({
  id: "example.summarize-git-status",
  workspace: "shared",
  input: gitStatusOutputSchema,
  output: summaryOutputSchema,
  goal: ({ exitCode, stdout, stderr }) =>
    `Summarize this Git status data. Exit code: ${exitCode}. Stdout: ${JSON.stringify(stdout)}. Stderr: ${JSON.stringify(stderr)}.`,
});

export default createFlow({
  id: "local-git-status-example",
  input: inputSchema,
  output: summaryOutputSchema,
})
  .task("status", localGitStatusTask, ({ input }) => input)
  .task("summary", summarizeGitStatusTask, ({ tasks }) => tasks.status.output)
  .output(({ tasks }) => tasks.summary.output)
  .define();
