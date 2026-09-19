// @test-scope ../../../workflows/all-features-example/workflow.ts
// @test-scope ../../../libs/runtime/src/runtime/mastra/operational-host.ts

import type { AgentTaskRequest } from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import { createOperationalWorkflow } from "@seqlane/runtime/operational-host";
import { describe, expect, it } from "vitest";

const { default: allFeaturesWorkflow } = await import(
  new URL(
    "../../../workflows/all-features-example/workflow.ts",
    import.meta.url,
  ).href
);

describe("all-features workflow example", () => {
  it("uses the Mastra-supported Flow authoring surface", () => {
    const built = buildWorkflow(allFeaturesWorkflow);
    const taskNodes = built.plan.nodes.filter((node) => node.type === "task");
    const context = taskNodes.find(
      (node) => node.taskId === "all-features-example-context",
    );
    const lanes = taskNodes.filter(
      (node) => node.taskId === "all-features-example-lane",
    );
    const policy = taskNodes.find(
      (node) => node.taskId === "all-features-example-policy",
    );
    const joined = taskNodes.find(
      (node) => node.taskId === "all-features-example-joined",
    );
    const polish = taskNodes.find(
      (node) => node.taskId === "all-features-example-polish",
    );

    expect(built.plan.workflow.id).toBe("all-features");
    expect(taskNodes.map(({ taskId }) => taskId)).toEqual([
      "all-features-example-context",
      "all-features-example-lane",
      "all-features-example-lane",
      "all-features-example-policy",
      "all-features-example-joined",
      "all-features-example-polish",
    ]);
    expect(context).toMatchObject({
      workspace: "shared",
      session: {
        type: "isolated",
        model: { model: { provider: "openai", model: "gpt-5.6-luna" } },
      },
    });
    expect(lanes).toHaveLength(2);
    expect(lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session: { type: "branch", from: "all-features-example-context:1" },
        }),
      ]),
    );
    expect(policy).toMatchObject({
      dependsOn: [],
      session: {
        type: "isolated",
        model: { model: { provider: "openai", model: "gpt-5.6-luna" } },
      },
    });
    expect(joined).toMatchObject({
      workspace: "exclusive",
      session: { type: "reuse", from: "all-features-example-lane:1" },
    });
    expect(joined?.dependsOn).toContain("all-features-example-policy:1");

    expect(built.plan.nodes.some((node) => node.type === "repeat")).toBe(false);
    expect(polish).toMatchObject({
      workspace: "shared",
      taskId: "all-features-example-polish",
      session: {
        type: "isolated",
        model: { model: { provider: "openai", model: "gpt-5.6-luna" } },
      },
    });
    expect(built.plan.output).toMatchObject({
      validation: { type: "ref", path: ["validation"] },
      polished: { type: "ref" },
    });
  });

  it("keeps the example tasks short and observable", async () => {
    const definitions = buildWorkflow(allFeaturesWorkflow).taskDefinitions;
    const context = definitions.get("all-features-example-context");

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
        references: ["workflows/minimal-example/workflow.ts"],
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

  it("compiles the feature tour through the Mastra adapter", () => {
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
