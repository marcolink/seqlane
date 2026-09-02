import { describe, expect, it } from "vitest";
import {
  buildWorkflow,
  defineTask,
  defineWorkflow,
} from "@seqlane/core";
import { z } from "zod";
import { createOpenCodeRunnerExecution } from "./runner.js";

describe("OpenCode runner factory", () => {
  it("captures authored workflow definitions without starting a session", () => {
    const task = defineTask({
      id: "task",
      workspace: "shared",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      goal: ({ value }) => `Process ${value}`,
    });
    const workflow = defineWorkflow({
      id: "authored-opencode",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      build: ({ input, run }) => run(task, { input }).output,
    });
    const factory = createOpenCodeRunnerExecution(workflow);

    expect(factory).toBeTypeOf("function");
    expect(buildWorkflow(workflow).plan.nodes[0]).not.toHaveProperty(
      "executor",
    );
  });
});
