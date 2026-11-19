// @test-scope ./workspace-resources.ts

import {
  buildWorkflow,
  createFlow,
  defineAgentTask,
  defineTask,
  validationResultSchema,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { workspaceResourcesForExecution } from "./workspace-resources.js";

const validationResult = validationResultSchema;

describe("nested workflow workspace resources", () => {
  it("reserves choice evaluator resources at their authored policy", () => {
    const task = defineTask({
      id: "choice-work",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      execute: async ({ input }) => input,
    });
    const evaluator = defineAgentTask({
      id: "choice-evaluator",
      input: task.output,
      output: validationResult,
      goal: () => "Evaluate output",
    });
    const built = buildWorkflow(
      createFlow({
        id: "choice-workflow",
        input: z.object({ select: z.boolean(), value: z.string() }),
        output: task.output,
      })
        .when(({ input }) => input.select)
        .task("decision", task, ({ input }) => ({ value: input.value }), {
          validateOutput: evaluator,
          workspace: "shared",
        })
        .otherwise(task, ({ input }) => ({ value: input.value }), {
          workspace: "shared",
        })
        .output(({ tasks }) => tasks.decision.output)
        .define(),
    );
    const workflow = {
      ...built,
      plan: {
        ...built.plan,
        nodes: built.plan.nodes.map((node) =>
          node.type === "choice"
            ? {
                ...node,
                validation: {
                  ...node.validation,
                  then: {
                    ...node.validation?.then,
                    source: {
                      type: "task" as const,
                      taskId: evaluator.id,
                      workspace: "shared" as const,
                    },
                  },
                },
              }
            : node,
        ),
      },
    };
    const resources = workspaceResourcesForExecution(
      new Map([
        [task.id, { key: "/task-work" }],
        [evaluator.id, { key: "/evaluator-work" }],
      ]),
      new Map([[workflow.workflow.id, workflow]]),
    );

    expect(resources.get(workflow.workflow.id)?.resources).toEqual(
      expect.arrayContaining([
        { key: "/evaluator-work", requiredPolicy: "shared" },
        { key: "/task-work", requiredPolicy: "shared" },
      ]),
    );
  });

  it("keeps repeat evaluator policy shared when the authored subtree is shared", () => {
    const task = defineTask({
      id: "repeat-work",
      input: z.object({ done: z.boolean() }),
      output: z.object({ done: z.boolean() }),
      execute: async ({ input }) => input,
    });
    const evaluator = defineAgentTask({
      id: "repeat-evaluator",
      input: task.output,
      output: validationResult,
      goal: () => "Evaluate output",
    });
    const built = buildWorkflow(
      createFlow({
        id: "repeat-workflow",
        input: task.input,
        output: task.output,
      })
        .task("loop", task, ({ input }) => input, {
          validateOutput: evaluator,
          workspace: "shared",
        })
        .until(({ result }) => result.done, { maxIterations: 1 })
        .output(({ tasks }) => tasks.loop.output)
        .define(),
    );
    const workflow = {
      ...built,
      plan: {
        ...built.plan,
        nodes: built.plan.nodes.map((node) =>
          node.type === "repeat" && node.validation?.source.type === "task"
            ? {
                ...node,
                validation: {
                  ...node.validation,
                  source: {
                    ...node.validation.source,
                    workspace: "shared" as const,
                  },
                },
              }
            : node,
        ),
      },
    };
    const resources = workspaceResourcesForExecution(
      new Map([
        [task.id, { key: "/task-work" }],
        [evaluator.id, { key: "/evaluator-work" }],
      ]),
      new Map([[workflow.workflow.id, workflow]]),
    );

    expect(resources.get(workflow.workflow.id)?.resources).toEqual(
      expect.arrayContaining([
        { key: "/evaluator-work", requiredPolicy: "shared" },
        { key: "/task-work", requiredPolicy: "shared" },
      ]),
    );
  });
});
