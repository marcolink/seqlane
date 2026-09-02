// @test-scope ../../../examples/all-features.ts

import { buildWorkflow } from "@seqlane/core";
import { describe, expect, it } from "vitest";

const { default: allFeaturesWorkflow } = await import(
  new URL("../../../examples/all-features.ts", import.meta.url).href
);

describe("all-features workflow example", () => {
  it("uses the complete supported Flow authoring surface", () => {
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
    const repeat = built.plan.nodes.find((node) => node.type === "repeat");

    expect(built.plan.workflow.id).toBe("all-features");
    expect(taskNodes.map(({ taskId }) => taskId)).toEqual([
      "all-features.context",
      "all-features.lane",
      "all-features.lane",
      "all-features.policy",
      "all-features.joined",
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

    expect(repeat).toMatchObject({
      maximumIterations: 1,
      body: {
        nodes: [
          { type: "task", taskId: "all-features.polish" },
          { type: "validation.check" },
          { type: "validation.gate", policy: "fail" },
          { type: "validation.check", source: { type: "task" } },
          { type: "validation.gate", policy: "repeat-postcondition" },
        ],
      },
    });
    expect(built.plan.output).toMatchObject({
      validation: { type: "ref", path: ["validation"] },
      polished: { type: "ref", nodeId: "repeat:1" },
    });
  });

  it("keeps the example tasks short and observable", () => {
    const definitions = buildWorkflow(allFeaturesWorkflow).taskDefinitions;
    const context = definitions.get("all-features.context");

    expect(context).toMatchObject({
      instructions: ["Return only two keywords and a short focus hint."],
      references: ["examples/minimal-workflow.ts"],
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
});
