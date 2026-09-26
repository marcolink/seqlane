// @test-scope ./contracts.ts
// @test-scope ./dsl.ts
// @test-scope ./builder.ts
// @test-scope ./plan-types.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildWorkflow, createFlow, defineTask, planSchema } from "./index.js";

const input = z.object({ review: z.boolean(), change: z.string() });
const reviewed = z.object({ kind: z.literal("reviewed"), risk: z.number() });
const approved = z.object({ kind: z.literal("approved"), reason: z.string() });
const result = z.discriminatedUnion("kind", [reviewed, approved]);

const reviewTask = defineTask({
  id: "review-change",
  input: z.object({ change: z.string() }),
  output: reviewed,
  execute: async () => ({ kind: "reviewed" as const, risk: 1 }),
});
const approveTask = defineTask({
  id: "approve-change",
  input: z.object({ change: z.string() }),
  output: approved,
  execute: async () => ({ kind: "approved" as const, reason: "standard" }),
});

describe("exclusive Flow choice", () => {
  it("builds one choice with distinct arm schemas and a union output", () => {
    const workflow = createFlow({ id: "choice-flow", input, output: result })
      .when(({ input: value }) => value.review)
      .task("decision", reviewTask, ({ input: value }) => ({
        change: value.change,
      }))
      .otherwise(approveTask, ({ input: value }) => ({
        change: value.change,
      }))
      .output(({ tasks }) => tasks.decision.output)
      .define();

    const built = buildWorkflow(workflow);
    expect(planSchema.safeParse(built.plan).success).toBe(true);
    expect(built.plan.nodes).toEqual([
      {
        type: "choice",
        nodeId: "choice:1",
        condition: {
          type: "ref",
          nodeId: "__seqlane_input",
          path: ["review"],
        },
        then: {
          type: "task",
          taskId: "review-change",
          nodeId: "choice:1:then",
          workspace: "exclusive",
          input: {
            change: {
              type: "ref",
              nodeId: "__seqlane_input",
              path: ["change"],
            },
          },
          dependsOn: [],
        },
        else: {
          type: "task",
          taskId: "approve-change",
          nodeId: "choice:1:else",
          workspace: "exclusive",
          input: {
            change: {
              type: "ref",
              nodeId: "__seqlane_input",
              path: ["change"],
            },
          },
          dependsOn: [],
        },
        dependsOn: [],
      },
    ]);
    expect(built.taskDefinitions.has("review-change")).toBe(true);
    expect(built.taskDefinitions.has("approve-change")).toBe(true);
    expect(built.plan.output).toEqual({
      type: "ref",
      nodeId: "choice:1",
      path: ["output"],
    });
  });

  it("requires an else arm and a Boolean condition in the type contract", () => {
    const start = createFlow({ id: "types", input, output: result });
    const typeContract = () => {
      start
        .when(({ input: value }) => value.review)
        .task("decision", reviewTask, ({ input: value }) => ({
          change: value.change,
        }))
        // @ts-expect-error A choice needs an otherwise arm before output.
        .output(() => undefined);
      // @ts-expect-error The condition must be a Boolean reference.
      start.when(({ input: value }) => value.change);
    };
    expect(typeContract).toBeTypeOf("function");
  });
});
