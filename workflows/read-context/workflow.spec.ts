// @test-scope ./workflow.ts
// @test-scope ./tasks/retrieval-workflow.ts
import { buildWorkflow } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import readContextWorkflow from "./workflow.js";

describe("read-context workflow", () => {
  it("runs independent evidence scrapes before selection", () => {
    const built = buildWorkflow(readContextWorkflow);
    const retrieval = built.workflowDefinitions.get("read-context-retrieve");
    const scrapeNodes = retrieval?.plan.nodes.filter(
      (node) => node.type === "task" && node.taskId.includes("-search"),
    );

    expect(built.plan.nodes).toContainEqual(
      expect.objectContaining({
        type: "workflow",
        workflowId: "read-context-retrieve",
      }),
    );
    expect(scrapeNodes).toHaveLength(3);
    expect(scrapeNodes?.every((node) => node.dependsOn.length === 0)).toBe(
      true,
    );
  });
});
