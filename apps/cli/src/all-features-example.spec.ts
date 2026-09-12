// @test-scope ../../../examples/all-features.ts
// @test-scope ../../../libs/runtime/src/runtime/mastra/operational-host.ts

import type { AgentTaskRequest } from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import { createOperationalWorkflow } from "@seqlane/runtime/operational-host";
import { describe, expect, it } from "vitest";

const { default: allFeaturesWorkflow } = await import(
  new URL("../../../examples/all-features.ts", import.meta.url).href
);

describe("all-features workflow example", () => {
  it("uses the Mastra-supported Flow authoring surface", () => {
    const built = buildWorkflow(allFeaturesWorkflow);
    const taskNodes = built.plan.nodes.filter((node) => node.type === "task");
    const context = taskNodes.find(
      (node) => node.taskId === "all-features.context",
    );
    const lanes = taskNodes.filter(
      (node) => node.taskId === "all-features.lane",
    );
    const policy = taskNodes.find(
      (node) => node.taskId === "all-features.policy",
    );
    const joined = taskNodes.find(
      (node) => node.taskId === "all-features.joined",
    );
    const polish = taskNodes.find(
      (node) => node.taskId === "all-features.polish",
    );

    expect(built.plan.workflow.id).toBe("all-features");
    expect(taskNodes.map(({ taskId }) => taskId)).toEqual([
      "all-features.context",
      "all-features.lane",
      "all-features.lane",
      "all-features.policy",
      "all-features.joined",
      "all-features.polish",
    ]);
    expect(context).toMatchObject({
      workspace: "shared",
      session: { type: "isolated" },
    });
    expect(lanes).toHaveLength(2);
    expect(lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session: { type: "branch", from: "all-features.context:1" },
        }),
      ]),
    );
    expect(policy?.dependsOn).toEqual([]);
    expect(joined).toMatchObject({
      workspace: "exclusive",
      session: { type: "reuse", from: "all-features.lane:1" },
    });
    expect(joined?.dependsOn).toContain("all-features.policy:1");

    expect(built.plan.nodes.some((node) => node.type === "repeat")).toBe(false);
    expect(polish).toMatchObject({
      workspace: "shared",
      taskId: "all-features.polish",
    });
    expect(built.plan.output).toMatchObject({
      validation: { type: "ref", path: ["validation"] },
      polished: { type: "ref" },
    });
  });

  it("keeps the example tasks short and observable", async () => {
    const definitions = buildWorkflow(allFeaturesWorkflow).taskDefinitions;
    const context = definitions.get("all-features.context");

    expect(context).toBeDefined();
    if (context === undefined) return;

    const requests: AgentTaskRequest[] = [];
    await context.execute({
      input: { topic: "workflow design", focus: "authoring" },
      signal: new AbortController().signal,
      context: {
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        runAgent: async (request) => {
          requests.push(request);
          return {};
        },
      },
    });

    expect(requests).toEqual([
      {
        goal: "Extract two keywords and a short focus hint for workflow design (authoring).",
        instructions: ["Return only two keywords and a short focus hint."],
        references: ["examples/minimal-workflow.ts"],
      },
    ]);
    expect(context).toMatchObject({
      observability: {
        studio: {
          input: { includePaths: ["/topic", "/focus"] },
          result: { includePaths: ["/keywords", "/hint"] },
          activity: {
            input: { includePaths: ["/topic"] },
            output: { includePaths: ["/keywords"] },
            metadata: { includePaths: ["/tool"] },
          },
        },
      },
    });
  });

  it("compiles through the Mastra adapter without repeat nodes", () => {
    const built = buildWorkflow(allFeaturesWorkflow);

    expect(() =>
      createOperationalWorkflow({
        key: "repository:all-features",
        plan: built.plan,
        workflow: allFeaturesWorkflow,
        taskDefinitions: built.taskDefinitions,
        validatorDefinitions: built.validatorDefinitions,
      }),
    ).not.toThrow();
  });
});
