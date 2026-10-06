// @test-scope ./dsl.ts
// @test-scope ./contracts.ts
// @test-scope ./builder.ts
// @test-scope ./plan-types.ts
// @test-scope ./index.ts

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  branch,
  buildWorkflow,
  createFlow,
  createSessionCheckpointRef,
  defineAgentTask,
  fork,
  isolated,
  planSchema,
  planSessionPolicySchema,
  type ModelSelection,
  type CanonicalPlan,
  type PlanSessionPolicy,
  type CanonicalPlanSessionPolicy,
  type PlanSessionPolicyInput,
} from "./index.js";

const model: ModelSelection = {
  model: { provider: "test", model: "selected" },
  reasoning: "high",
};

describe("session fork compatibility", () => {
  it("separates compatible policy inputs from canonical Plan outputs", () => {
    expectTypeOf<CanonicalPlanSessionPolicy["type"]>().toEqualTypeOf<
      "isolated" | "reuse" | "fork"
    >();
    expectTypeOf<PlanSessionPolicyInput["type"]>().toEqualTypeOf<
      "isolated" | "reuse" | "fork" | "branch"
    >();
    expectTypeOf<PlanSessionPolicy>().toEqualTypeOf<PlanSessionPolicyInput>();
    type CanonicalTask = Extract<
      CanonicalPlan["nodes"][number],
      { type: "task" }
    >;
    expectTypeOf<NonNullable<CanonicalTask["session"]>["type"]>().toEqualTypeOf<
      "isolated" | "reuse" | "fork"
    >();
  });

  it.each([undefined, model])(
    "preserves deprecated helper arguments and return shape (%j)",
    (selection) => {
      const checkpoint = createSessionCheckpointRef("source");
      const current = fork(checkpoint, selection);
      const legacy = branch(checkpoint, selection);
      expectTypeOf(current.type).toEqualTypeOf<"fork">();
      expectTypeOf(legacy.type).toEqualTypeOf<"branch">();
      expect(current).toEqual({
        type: "fork",
        from: checkpoint,
        ...(selection === undefined ? {} : { model: selection }),
      });
      expect(legacy).toEqual({ ...current, type: "branch" });
      expect(legacy.from).toBe(checkpoint);
    },
  );

  it.each([fork, branch])(
    "builds canonical Plans through either exported helper (%s)",
    (helper) => {
      const schema = z.object({ value: z.string() });
      const task = defineAgentTask({
        id: "session-task",
        input: schema,
        output: schema,
        goal: ({ value }) => value,
      });
      const built = buildWorkflow(
        createFlow({
          id: "session-compatibility",
          input: schema,
          output: schema,
        })
          .task("source", task, ({ input }) => input, { session: isolated() })
          .task("consumer", task, ({ input }) => input, {
            session: ({ tasks }) => helper(tasks.source.session, model),
          })
          .output(({ tasks }) => tasks.consumer.output)
          .define(),
      );
      expect(built.plan.nodes[1]).toMatchObject({
        session: { type: "fork", from: "session-task:1", model },
        dependsOn: ["session-task:1"],
      });
      expect(planSchema.parse(built.plan)).toEqual(built.plan);
    },
  );

  it.each(["fork", "branch"])(
    "normalizes serialized session policies (%s)",
    (type) => {
      const parsed = planSchema.parse({
        workflow: { id: "legacy-session" },
        nodes: [
          {
            type: "task",
            taskId: "consumer",
            nodeId: "consumer:1",
            workspace: "shared",
            input: {},
            dependsOn: ["source"],
            session: { type, from: "source", model },
          },
        ],
        output: null,
      });
      expect(parsed.nodes[0]).toMatchObject({
        session: { type: "fork", from: "source", model },
      });
    },
  );

  it("normalizes a legacy session policy inside a repeated attempt", () => {
    const parsed = planSchema.parse({
      workflow: { id: "legacy-repeat" },
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
            session: { type: "branch", from: "source", model },
          },
          until: {
            type: "ref",
            nodeId: "repeat:1:attempt",
            path: ["output", "done"],
          },
        },
      ],
      output: null,
    });
    expect(parsed.nodes[0]).toMatchObject({
      attempt: { session: { type: "fork", from: "source", model } },
    });
  });

  it.each(["fork", "branch"])(
    "rejects malformed current and legacy policies (%s)",
    (type) => {
      for (const policy of [
        { type, from: "" },
        { type, from: 123 },
        { type, from: "source", model: { model: "invalid" } },
        { type, from: "source", extra: true },
      ]) {
        expect(planSessionPolicySchema.safeParse(policy).success).toBe(false);
      }
    },
  );
});
