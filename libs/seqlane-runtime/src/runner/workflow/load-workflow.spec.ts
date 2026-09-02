import type { WorkflowReference } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { loadWorkflow } from "./load-workflow.js";

const validReference: WorkflowReference = {
  id: "renovate",
  moduleSpecifier: "@seqlane/fixtures/renovate-workflow",
  exportName: "createRenovatePlan",
};

describe("loadWorkflow", () => {
  it("imports and builds a Plan from the selected export", async () => {
    const loaded = await loadWorkflow(validReference, { dependency: "demo" });

    expect(loaded.reference).toEqual(validReference);
    expect(loaded.plan.workflow.id).toBe("fix-renovate-update");
  });

  it("rejects a missing export", async () => {
    await expect(
      loadWorkflow({ ...validReference, exportName: "missing" }, null),
    ).rejects.toThrow('does not export "missing"');
  });

  it("rejects an export that does not build a valid Plan", async () => {
    await expect(
      loadWorkflow(
        {
          ...validReference,
          moduleSpecifier: "data:text/javascript,export const invalid = 42",
          exportName: "invalid",
        },
        null,
      ),
    ).rejects.toThrow("must be a Plan or a Plan factory");
  });

  it("builds an authored workflow and retains its task schemas", async () => {
    const source = `
      const schema = { parse: (value) => value };
      const task = {
        id: "authored-task",
        workspace: "shared",
        input: schema,
        output: schema,
        goal: () => "demo",
      };
      export const authored = {
        id: "authored",
        input: schema,
        output: schema,
        build: ({ run }) => {
          const result = run(task, { input: { value: "demo" } });
          return { value: result.output.value };
        },
      };
    `;
    const reference: WorkflowReference = {
      id: "authored",
      moduleSpecifier: `data:text/javascript,${encodeURIComponent(source)}`,
      exportName: "authored",
    };

    const loaded = await loadWorkflow(reference, { value: "demo" });

    expect(loaded.plan.nodes).toMatchObject([
      {
        taskId: "authored-task",
        nodeId: "authored-task:1",
        workspace: "shared",
        dependsOn: [],
      },
    ]);
    expect(loaded.plan.output).toEqual({
      value: {
        type: "ref",
        nodeId: "authored-task:1",
        path: ["output", "value"],
      },
    });
    expect(loaded.taskDefinitions?.get("authored-task")).toBeDefined();
  });
});
