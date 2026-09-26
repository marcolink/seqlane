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
    const inspection = taskNodes.find(
      (node) => node.taskId === "all-features-example-inspect",
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
      "all-features-example-inspect",
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
    expect(inspection).toMatchObject({
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
      inspection: { type: "ref", path: ["output"] },
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
        timeoutMs: 120_000,
      },
    ]);
    expect(context).not.toHaveProperty("observability");
  });

  it("requires the inspection task to use OpenCode read", async () => {
    const definitions = buildWorkflow(allFeaturesWorkflow).taskDefinitions;
    const inspection = definitions.get("all-features-example-inspect");

    expect(inspection).toBeDefined();
    if (inspection === undefined) return;

    const requests: AgentTaskRequest[] = [];
    await inspection.execute({
      input: {},
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
        goal: "Read package.json with OpenCode's read tool and return its package name and version.",
        instructions: [
          "You must call OpenCode's read tool on package.json before answering.",
          "Do not infer the package contents from context.",
          "Return the exact package name and version from the file.",
        ],
        timeoutMs: 120_000,
      },
    ]);
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
