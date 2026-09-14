// @test-scope ./plan-types.ts
// @test-scope ./bindings.ts
// @test-scope ./contracts.ts
// @test-scope ./dsl.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createFlow,
  buildWorkflow,
  defineTask,
  planNodeSchema,
  planSchema,
  taskDefinitionRegistrySchema,
  valueBindingSchema,
} from "./index.js";

const identity = z.unknown();

describe("canonical Plan schemas", () => {
  it("accepts a Plan produced by the sole flow authoring API", () => {
    const task = defineTask({
      id: "schema-task",
      input: identity,
      output: identity,
      execute: async ({ input }) => input,
    });
    const workflow = createFlow({
      id: "schema-flow",
      input: identity,
      output: identity,
    })
      .task("task", task, ({ input }) => input)
      .output(
        ({ tasks }: { tasks: { task: { output: unknown } } }) =>
          tasks.task.output,
      )
      .define();

    expect(Object.hasOwn(workflow, "build")).toBe(false);
    expect(
      planSchema.safeParse({
        workflow: { id: workflow.id },
        nodes: [
          {
            type: "task",
            taskId: task.id,
            nodeId: "schema-task:1",
            workspace: "exclusive",
            input: { type: "ref", nodeId: "__seqlane_input", path: [] },
            dependsOn: [],
          },
        ],
        output: { type: "ref", nodeId: "schema-task:1", path: ["output"] },
      }).success,
    ).toBe(true);
  });

  it("rejects unsupported nodes and repeat limits outside 1..1000", () => {
    expect(
      planNodeSchema.safeParse({ type: "branch", nodeId: "branch:1" }).success,
    ).toBe(false);
    const repeat = {
      type: "repeat",
      nodeId: "repeat:1",
      input: null,
      dependsOn: [],
      maximumIterations: 1_001,
      attempt: {
        type: "task",
        taskId: "repeat-task",
        nodeId: "repeat:1:attempt",
        workspace: "exclusive",
        input: null,
        dependsOn: [],
      },
      until: { type: "ref", nodeId: "repeat:1:attempt", path: ["output"] },
    };
    expect(planNodeSchema.safeParse(repeat).success).toBe(false);
    expect(
      valueBindingSchema.safeParse({ nested: ["ok", 1, true, null] }).success,
    ).toBe(true);
  });

  it("rejects a registry key that does not match its definition ID", () => {
    const task = defineTask({
      id: "registered",
      input: identity,
      output: identity,
      execute: async () => null,
    });
    expect(
      taskDefinitionRegistrySchema.safeParse(new Map([["other", task]]))
        .success,
    ).toBe(false);
  });

  it("rejects malformed ValueRef bindings instead of treating them as records", () => {
    expect(
      planSchema.safeParse({
        workflow: { id: "malformed-ref" },
        nodes: [],
        output: { type: "ref", nodeId: "missing", path: "not-an-array" },
      }).success,
    ).toBe(false);
  });

  it("snapshots declarations and output when define is called", () => {
    const task = defineTask({
      id: "snapshot-task",
      input: identity,
      output: identity,
      execute: async ({ input }) => input,
    });
    const withTask = createFlow({
      id: "snapshot-flow",
      input: identity,
      output: identity,
    }).task("first", task, ({ input }) => input);
    const workflow = withTask
      .output(
        ({ tasks }: { tasks: { first: { output: unknown } } }) =>
          tasks.first.output,
      )
      .define();

    withTask.task("added-later", task, ({ input }) => input);

    expect(buildWorkflow(workflow).plan.nodes).toHaveLength(1);
  });
});
