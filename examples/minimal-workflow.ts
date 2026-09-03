import {
  createFlow,
  defineTask,
  defineValidator,
  isolated,
} from "@seqlane/core";
import { openai } from "@seqlane/core/models";
import { z } from "zod";

const inputSchema = z.object({ topic: z.string() });
const draftSchema = z.object({ draft: z.string() });
const answerSchema = z.object({ answer: z.string() });

const draftValidator = defineValidator({
  id: "example.prepare.semantic",
  input: draftSchema,
  validate: ({ draft }) =>
    draft.trim().length > 0
      ? { success: true }
      : {
          success: false,
          issues: [
            {
              code: "empty-draft",
              message: "The prepared draft must not be empty",
            },
          ],
        },
});

const prepareTask = defineTask({
  id: "example.prepare",
  workspace: "shared",
  input: inputSchema,
  output: draftSchema,
  goal: ({ topic }) => `Write a short draft about ${topic}.`,
  instructions: ["Return one concise paragraph."],
});

const finishTask = defineTask({
  id: "example.finish",
  workspace: "shared",
  input: draftSchema,
  output: answerSchema,
  goal: ({ draft }) => `Polish this draft into a clear final answer: ${draft}`,
  instructions: ["Return only the polished answer."],
});

export default createFlow({
  id: "minimal-example",
  input: inputSchema,
  output: answerSchema,
})
  .task("prepare", prepareTask, ({ input }) => input, {
    session: isolated({
      model: openai("gpt-5.6-luna"),
      reasoning: "high",
    }),
    validateOutput: draftValidator,
  })
  .task("finish", finishTask, ({ tasks }) => tasks.prepare.output)
  .output(({ tasks }) => tasks.finish.output)
  .define();
