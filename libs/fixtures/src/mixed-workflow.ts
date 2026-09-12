import { createFlow, defineAgentTask, defineValidator } from "@seqlane/core";
import { z } from "zod";

const inputSchema = z.object({ id: z.string() });
const agentOutputSchema = z.object({ summary: z.string() });
const operationOutputSchema = z.object({ status: z.string() });

const summaryValidator = defineValidator({
  id: "mixed.agent.semantic",
  input: agentOutputSchema,
  validate: ({ summary }) =>
    summary.trim().length > 0
      ? { success: true }
      : {
          success: false,
          issues: [
            {
              code: "empty-summary",
              message: "The agent summary must not be empty",
            },
          ],
        },
});

export const mixedAgentTask = defineAgentTask({
  id: "mixed.agent",
  input: inputSchema,
  output: agentOutputSchema,
  goal: ({ id }) => `Summarize ${id}`,
});

export const mixedStatusTask = defineAgentTask({
  id: "mixed.operation",
  input: z.object({ summary: z.string() }),
  output: operationOutputSchema,
  goal: ({ summary }) => `Look up the status for ${summary}.`,
});

export const mixedWorkflow = createFlow({
  id: "mixed-agent-operation",
  input: inputSchema,
  output: operationOutputSchema,
})
  .task("summary", mixedAgentTask, ({ input }) => input, {
    workspace: "shared",
    validateOutput: summaryValidator,
  })
  .task(
    "status",
    mixedStatusTask,
    ({ tasks }) => ({
      summary: tasks.summary.output.summary,
    }),
    { workspace: "shared" },
  )
  .output(({ tasks }) => tasks.status.output)
  .define();
