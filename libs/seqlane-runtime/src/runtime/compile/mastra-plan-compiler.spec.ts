// @test-scope ./mastra-plan-compiler.ts
// @test-scope ../validation/plan-validation.ts
// @test-scope ../plan/plan-ordering.ts
// @test-scope ../plan/binding-resolution.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plan, PlanNode, TaskDefinition } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileBuiltWorkflowToMastra,
  compilePlanToMastra,
} from "./mastra-plan-compiler.js";
import { createMastraRuntime } from "../mastra/mastra-runtime.js";

const taskInput = z.object({ value: z.number() });
const taskOutput = z.object({ value: z.number() });

function task(
  nodeId: string,
  dependsOn: readonly string[] = [],
  input: PlanNode["input"] = {},
): PlanNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    input,
    dependsOn,
  };
}

function plan(nodes: readonly PlanNode[], output: Plan["output"]): Plan {
  return { workflow: { id: "mastra-plan-compiler" }, nodes, output };
}

function definitions(...ids: string[]): ReadonlyMap<string, TaskDefinition> {
  return new Map(
    ids.map((id) => [
      id,
      {
        id,
        input: id === "source" ? z.object({}) : taskInput,
        output: taskOutput,
        goal: ({ value }: { value: number }) => `process ${value}`,
      },
    ]),
  );
}

describe("Mastra Plan compiler", () => {
  it("creates deterministic inspectable steps and preserves the dependency graph", () => {
    const source = plan(
      [
        task("result", ["left", "right"]),
        task("right", ["start"], {
          value: { type: "ref", nodeId: "start", path: ["output", "value"] },
        }),
        task("start"),
        task("left", ["start"], {
          value: { type: "ref", nodeId: "start", path: ["output", "value"] },
        }),
      ],
      { type: "ref", nodeId: "result", path: ["output"] },
    );
    const options = {
      taskDefinitions: definitions("start", "left", "right", "result"),
      workflow: { input: z.object({}), output: taskOutput },
      executeInvocation: async ({ input }: { input: unknown }) => input,
    };

    const first = compilePlanToMastra(source, options);
    const second = compilePlanToMastra(source, options);

    expect(first.invocationSteps.map(({ nodeId }) => nodeId)).toEqual([
      "start",
      "left",
      "right",
      "result",
    ]);
    expect(first.workflow.serializedStepGraph).toEqual(
      second.workflow.serializedStepGraph,
    );
    expect(first.workflow.serializedStepGraph).toEqual([
      {
        type: "step",
        step: expect.objectContaining({ id: "start" }),
      },
      {
        type: "parallel",
        steps: [
          { type: "step", step: expect.objectContaining({ id: "left" }) },
          { type: "step", step: expect.objectContaining({ id: "right" }) },
        ],
      },
      {
        type: "step",
        step: expect.objectContaining({ id: "result" }),
      },
      {
        type: "step",
        step: expect.objectContaining({ id: "__seqlane_result" }),
      },
    ]);
    expect(first.workflow.steps.start?.metadata).toEqual(
      expect.objectContaining({
        seqlane: expect.objectContaining({
          planNodeId: "start",
          dependsOn: [],
        }),
      }),
    );
  });

  it("resolves typed bindings and returns the declared workflow output", async () => {
    const sourceNode = task("source");
    const finalNode = task("final", ["source"], {
      value: { type: "ref", nodeId: "source", path: ["output", "value"] },
    });
    const source = plan([sourceNode, finalNode], {
      type: "ref",
      nodeId: "final",
      path: ["output"],
    });
    const invocations: Array<{ nodeId: string; input: unknown }> = [];
    const compiled = compileBuiltWorkflowToMastra(
      {
        plan: source,
        workflow: { input: z.object({}), output: taskOutput },
        taskDefinitions: definitions("source", "final"),
      },
      {
        executeInvocation: async ({ node, input }) => {
          invocations.push({ nodeId: node.nodeId, input });
          const value =
            node.nodeId === "source" ? 0 : taskInput.parse(input).value;
          return { value: value + 1 };
        },
      },
    );
    const runtime = createMastraRuntime([
      { key: compiled.key, workflow: compiled.workflow },
    ]);

    await expect(
      runtime.run({
        workflowKey: compiled.key,
        input: {},
        workId: "work-1",
        runId: "run-1",
      }),
    ).resolves.toEqual({ status: "succeeded", result: { value: 2 } });
    expect(invocations).toEqual([
      { nodeId: "source", input: {} },
      { nodeId: "final", input: { value: 1 } },
    ]);
  });

  it("rejects malformed plans before creating a Mastra workflow", () => {
    const cyclic = plan([task("a", ["b"]), task("b", ["a"])], {
      type: "ref",
      nodeId: "a",
      path: ["output"],
    });

    expect(() => compilePlanToMastra(cyclic)).toThrow(/cycle/i);
  });

  it("normalizes typed input failures through Mastra's workflow result", async () => {
    const source = plan([task("source")], {
      type: "ref",
      nodeId: "source",
      path: ["output"],
    });
    const compiled = compilePlanToMastra(source, {
      taskDefinitions: new Map([
        [
          "source",
          {
            id: "source",
            input: taskInput,
            output: taskOutput,
            goal: () => "source",
          },
        ],
      ]),
      workflow: { input: z.object({}), output: taskOutput },
      executeInvocation: async ({ input }) => input,
    });
    const result = await (
      await compiled.workflow.createRun({ runId: "malformed-run" })
    ).start({ inputData: {} });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toMatch(/value/i);
    }
  });

  it("keeps Mastra imports out of core Plan source", () => {
    const planTypes = readFileSync(
      fileURLToPath(
        new URL("../../../../seqlane-core/src/plan-types.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(planTypes).not.toContain("@mastra/");
  });
});
