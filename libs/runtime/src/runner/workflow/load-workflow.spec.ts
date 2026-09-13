import type { WorkflowReference } from "@seqlane/protocol";
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

  it("builds an authored Flow and retains its task schemas", async () => {
    const zodSpecifier = import.meta.resolve("zod");
    const coreSpecifier = import.meta.resolve("@seqlane/core");
    const source = `
      import { z } from ${JSON.stringify(zodSpecifier)};
      import { createFlow, defineTask } from ${JSON.stringify(coreSpecifier)};
      const schema = z.unknown();
      const task = defineTask({
        id: "authored-task",
        workspace: "exclusive",
        input: schema,
        output: schema,
        execute: async ({ input }) => input,
      });
      export const authored = createFlow({
        id: "authored",
        input: schema,
        output: schema,
      })
        .task("task", task, ({ input }) => ({ value: input }))
        .output(({ tasks }) => ({ value: tasks.task.output.value }))
        .define();
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
        workspace: "exclusive",
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
    expect(loaded.definition?.input).toBeDefined();
    expect(loaded.definition?.output).toBeDefined();
  });

  it("validates and retains authored nested workflows", async () => {
    const zodSpecifier = import.meta.resolve("zod");
    const coreSpecifier = import.meta.resolve("@seqlane/core");
    const source = `
      import { z } from ${JSON.stringify(zodSpecifier)};
      import { createFlow, defineTask } from ${JSON.stringify(coreSpecifier)};
      const schema = z.object({ value: z.number() });
      const childTask = defineTask({
        id: "nested-loader-task",
        input: schema,
        output: schema,
        execute: async ({ input }) => input,
      });
      const child = createFlow({ id: "nested-loader-child", input: schema, output: schema })
        .task("task", childTask, ({ input }) => input)
        .output(({ tasks }) => tasks.task.output)
        .define();
      export const parent = createFlow({ id: "nested-loader-parent", input: schema, output: schema })
        .task("child", child, ({ input }) => input)
        .output(({ tasks }) => tasks.child.output)
        .define();
    `;
    const loaded = await loadWorkflow(
      {
        id: "nested-loader-parent",
        moduleSpecifier: `data:text/javascript,${encodeURIComponent(source)}`,
        exportName: "parent",
      },
      { value: 1 },
    );

    expect(loaded.built.workflowDefinitions.has("nested-loader-child")).toBe(
      true,
    );
    expect(loaded.plan.nodes).toMatchObject([
      { type: "workflow", workflowId: "nested-loader-child" },
    ]);
  });

  it("rejects an unsupported Plan node before validation or compilation", async () => {
    const source = `export const invalid = ${JSON.stringify({
      workflow: { id: "invalid" },
      nodes: [{ type: "branch", nodeId: "branch:1", dependsOn: [] }],
      output: null,
    })};`;
    await expect(
      loadWorkflow(
        {
          ...validReference,
          moduleSpecifier: `data:text/javascript,${encodeURIComponent(source)}`,
          exportName: "invalid",
        },
        null,
      ),
    ).rejects.toThrow("Plan");
  });

  it("rejects malformed Plan bindings before runtime validation", async () => {
    const source = `export const invalid = ${JSON.stringify({
      workflow: { id: "invalid" },
      nodes: [],
      output: { type: "ref", nodeId: "missing", path: "not-an-array" },
    })};`;
    await expect(
      loadWorkflow(
        {
          ...validReference,
          moduleSpecifier: `data:text/javascript,${encodeURIComponent(source)}`,
          exportName: "invalid",
        },
        null,
      ),
    ).rejects.toThrow("Plan");
  });
});
