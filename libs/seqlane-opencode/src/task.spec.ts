import { describe, expect, it } from "vitest";
import { buildWorkflow, defineTask, defineWorkflow } from "@seqlane/core";
import { z } from "zod";
import { getOpenCodeTask } from "./task.js";

describe("private OpenCode task binding", () => {
  it("reads generic agent work without an adapter authoring contract", () => {
    const investigate = defineTask({
      id: "investigate",
      input: z.object({ dependency: z.string() }),
      output: z.object({ files: z.array(z.string()) }),
      execute: async () => ({ files: [] }),
    });
    const workflow = defineWorkflow({
      id: "typed-agent",
      input: z.object({ dependency: z.string() }),
      output: z.object({ files: z.array(z.string()) }),
      build: ({ input, run }) => run(investigate, { input }).output,
    });

    const built = buildWorkflow(workflow);
    const task = getOpenCodeTask(built.taskDefinitions, "investigate");

    expect(task).toBe(investigate);
    expect(JSON.stringify(built.plan)).not.toContain("Investigate");
    expect(JSON.stringify(built.plan)).not.toContain("package.json");
  });

  it("keeps repeated generic agent invocations resolvable from one definition", () => {
    const task = defineTask({
      id: "repeat",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      execute: async ({ input }) => input,
    });
    const workflow = defineWorkflow({
      id: "repeat-agent",
      input: z.object({ value: z.string() }),
      output: z.object({ first: z.string(), second: z.string() }),
      build: ({ input, run }) => {
        const first = run(task, { input });
        const second = run(task, { input });
        return { first: first.output.value, second: second.output.value };
      },
    });

    const built = buildWorkflow(workflow);
    expect(built.plan.nodes).toHaveLength(2);
    expect(getOpenCodeTask(built.taskDefinitions, "repeat")).toBe(task);
  });
});
