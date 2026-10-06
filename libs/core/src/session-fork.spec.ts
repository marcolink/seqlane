// @test-scope ./dsl.ts
// @test-scope ./contracts.ts
// @test-scope ./builder.ts
// @test-scope ./plan-types.ts
// @test-scope ./index.ts
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import * as api from "./index.js";
import {
  buildWorkflow,
  createFlow,
  createSessionCheckpointRef,
  defineAgentTask,
  fork,
  isolated,
  planSchema,
  planSessionPolicySchema,
  type ModelSelection,
  type PlanSessionPolicy,
} from "./index.js";

const model: ModelSelection = {
  model: { provider: "test", model: "selected" },
  reasoning: "high",
};

describe("session forking", () => {
  it("exposes only the fork session name", () => {
    expect(api).not.toHaveProperty("branch");
    expectTypeOf<PlanSessionPolicy["type"]>().toEqualTypeOf<
      "isolated" | "reuse" | "fork"
    >();
    expect(
      planSessionPolicySchema.safeParse({ type: "branch", from: "source" })
        .success,
    ).toBe(false);
  });
  it.each([undefined, model])(
    "creates a fork policy with optional model selection (%j)",
    (selection) => {
      const checkpoint = createSessionCheckpointRef("source");
      const policy = fork(checkpoint, selection);
      expectTypeOf(policy.type).toEqualTypeOf<"fork">();
      expect(policy).toEqual({
        type: "fork",
        from: checkpoint,
        ...(selection === undefined ? {} : { model: selection }),
      });
      expect(policy.from).toBe(checkpoint);
    },
  );
  it("builds a fork policy with its source dependency", () => {
    const schema = z.object({ value: z.string() });
    const task = defineAgentTask({
      id: "session-task",
      input: schema,
      output: schema,
      goal: ({ value }) => value,
    });
    const built = buildWorkflow(
      createFlow({ id: "session-fork", input: schema, output: schema })
        .task("source", task, ({ input }) => input, { session: isolated() })
        .task("consumer", task, ({ input }) => input, {
          session: ({ tasks }) => fork(tasks.source.session, model),
        })
        .output(({ tasks }) => tasks.consumer.output)
        .define(),
    );
    expect(built.plan.nodes[1]).toMatchObject({
      session: { type: "fork", from: "session-task:1", model },
      dependsOn: ["session-task:1"],
    });
    expect(planSchema.parse(built.plan)).toEqual(built.plan);
  });
  it("round-trips a fork policy inside a repeated attempt", () => {
    const plan = {
      workflow: { id: "fork-repeat" },
      nodes: [
        {
          type: "repeat",
          nodeId: "repeat:1",
          input: {},
          dependsOn: [],
          maximumIterations: 2,
          attempt: {
            type: "task",
            taskId: "consumer",
            nodeId: "repeat:1:attempt",
            workspace: "shared",
            input: {},
            dependsOn: ["source"],
            session: { type: "fork", from: "source", model },
          },
          until: {
            type: "ref",
            nodeId: "repeat:1:attempt",
            path: ["output", "done"],
          },
        },
      ],
      output: null,
    };
    expect(planSchema.parse(plan)).toEqual(plan);
  });
  it("rejects malformed fork policies", () => {
    for (const policy of [
      { type: "fork", from: "" },
      { type: "fork", from: 123 },
      { type: "fork", from: "source", model: { model: "invalid" } },
      { type: "fork", from: "source", extra: true },
    ]) {
      expect(planSessionPolicySchema.safeParse(policy).success).toBe(false);
    }
  });
});
