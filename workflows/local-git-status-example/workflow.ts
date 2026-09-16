import { createFlow, defineAgentTask, defineShellTask } from "@seqlane/core";
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

const localGitStatusTask = defineShellTask({
  id: "local-git-status-example-status",
  input: inputSchema,
  executable: "git",
  argv: () => ["status", "--porcelain=v1"],
});

const summarizeGitStatusTask = defineAgentTask({
  id: "local-git-status-example-summarize",
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
  .task("status", localGitStatusTask, ({ input }) => input, {
    workspace: "shared",
  })
  .task("summary", summarizeGitStatusTask, ({ tasks }) => tasks.status.output, {
    workspace: "shared",
  })
  .output(({ tasks }) => tasks.summary.output)
  .define();
