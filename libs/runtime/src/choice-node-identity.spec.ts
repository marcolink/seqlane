// @test-scope ./start-workflow-run.ts
// @test-scope ./runtime/validation/plan-validation.ts
// @test-scope ./runtime/compile/mastra-choice-compiler.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildWorkflow, createFlow, defineTask } from "@seqlane/core";
import { startWorkflowRun } from "./start-workflow-run.js";

describe("choice node identity through the runtime", () => {
  it.each([true, false])(
    "runs an ordinary task named choice (choice first: %s)",
    async (choiceFirst) => {
      const value = z.object({ name: z.string() });
      const ordinary = defineTask({
        id: "choice",
        input: z.object({}),
        output: value,
        execute: async () => ({ name: "ordinary" }),
      });
      const selected = defineTask({
        id: "selected-choice-arm",
        input: value,
        output: value,
        execute: async ({ input }) => input,
      });
      const options = {
        id: "choice-id-collision",
        input: z.object({ route: z.boolean() }),
        output: z.object({ ordinary: value, decision: value }),
      };
      const flow = choiceFirst
        ? createFlow(options)
            .when(({ input }) => input.route)
            .task("decision", selected, () => ({ name: "then" }))
            .otherwise(selected, () => ({ name: "else" }))
            .task("ordinary", ordinary, () => ({}))
            .output(({ tasks }) => ({
              ordinary: tasks.ordinary.output,
              decision: tasks.decision.output,
            }))
            .define()
        : createFlow(options)
            .task("ordinary", ordinary, () => ({}))
            .when(({ input }) => input.route)
            .task("decision", selected, () => ({ name: "then" }))
            .otherwise(selected, () => ({ name: "else" }))
            .output(({ tasks }) => ({
              ordinary: tasks.ordinary.output,
              decision: tasks.decision.output,
            }))
            .define();
      const workflow = buildWorkflow(flow);
      for (const route of [true, false]) {
        const run = startWorkflowRun({
          workflow,
          input: { route },
          workspace: process.cwd(),
          identity: {
            workId: "choice-id-work",
            runId: `choice-id-${choiceFirst}-${route}`,
          },
          events: { emit: () => undefined },
        });
        await expect(run.outcome).resolves.toMatchObject({
          status: "succeeded",
          result: {
            ordinary: { name: "ordinary" },
            decision: { name: route ? "then" : "else" },
          },
        });
      }
    },
  );
});
