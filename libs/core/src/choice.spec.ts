// @test-scope ./contracts.ts
// @test-scope ./dsl.ts
// @test-scope ./builder.ts
// @test-scope ./plan-types.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  branch,
  buildWorkflow,
  createFlow,
  defineAgentTask,
  defineTask,
  planSchema,
} from "./index.js";

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
  it.each([
    ["task", true],
    ["task", false],
    ["workflow", true],
    ["workflow", false],
  ] as const)(
    "allocates distinct IDs for an ordinary %s named choice (choice first: %s)",
    (kind, choiceFirst) => {
      const task = defineTask({
        id: "choice",
        input: z.object({ change: z.string() }),
        output: reviewed,
        execute: async () => ({ kind: "reviewed" as const, risk: 2 }),
      });
      const child = createFlow({
        id: "choice",
        input: task.input,
        output: reviewed,
      })
        .task("review", reviewTask, ({ input: value }) => value)
        .output(({ tasks }) => tasks.review.output)
        .define();
      const options = {
        id: "choice-id-collision",
        input,
        output: z.object({ ordinary: reviewed, decision: result }),
      };
      const base = createFlow(options);
      const firstChoice = base
        .when(({ input: value }) => value.review)
        .task("decision", reviewTask, ({ input: value }) => ({
          change: value.change,
        }))
        .otherwise(approveTask, ({ input: value }) => ({
          change: value.change,
        }));
      const afterChoice =
        kind === "task"
          ? firstChoice.task("ordinary", task, ({ input: value }) => ({
              change: value.change,
            }))
          : firstChoice.task("ordinary", child, ({ input: value }) => ({
              change: value.change,
            }));
      const choiceFirstFlow = afterChoice
        .output(({ tasks }) => ({
          ordinary: tasks.ordinary.output,
          decision: tasks.decision.output,
        }))
        .define();
      const ordinaryBase = createFlow(options);
      const firstOrdinary =
        kind === "task"
          ? ordinaryBase.task("ordinary", task, ({ input: value }) => ({
              change: value.change,
            }))
          : ordinaryBase.task("ordinary", child, ({ input: value }) => ({
              change: value.change,
            }));
      const ordinaryFirstFlow = firstOrdinary
        .when(({ input: value }) => value.review)
        .task("decision", reviewTask, ({ input: value }) => ({
          change: value.change,
        }))
        .otherwise(approveTask, ({ input: value }) => ({
          change: value.change,
        }))
        .output(({ tasks }) => ({
          ordinary: tasks.ordinary.output,
          decision: tasks.decision.output,
        }))
        .define();
      const flow = choiceFirst ? choiceFirstFlow : ordinaryFirstFlow;
      const { plan } = buildWorkflow(flow);
      expect(planSchema.safeParse(plan).success).toBe(true);
      expect(plan.nodes.map((node) => node.nodeId)).toEqual([
        "choice:1",
        "choice:2",
      ]);
      expect(plan.output).toEqual({
        ordinary: {
          type: "ref",
          nodeId: choiceFirst ? "choice:2" : "choice:1",
          path: ["output"],
        },
        decision: {
          type: "ref",
          nodeId: choiceFirst ? "choice:1" : "choice:2",
          path: ["output"],
        },
      });
      expect(plan.nodes[choiceFirst ? 0 : 1]).toMatchObject({
        type: "choice",
        then: { nodeId: `choice:${choiceFirst ? 1 : 2}:then` },
        else: { nodeId: `choice:${choiceFirst ? 1 : 2}:else` },
      });
    },
  );

  it("keeps a choice arm session source off the choice's eligibility edges", () => {
    const source = defineAgentTask({
      id: "session-source",
      input: z.object({ change: z.string() }),
      output: z.object({ change: z.string() }),
      goal: () => "Create source checkpoint",
    });
    const selected = defineAgentTask({
      id: "selected-branch",
      input: z.object({ change: z.string() }),
      output: reviewed,
      goal: () => "Review change",
    });
    const workflow = createFlow({ id: "choice-session", input, output: result })
      .task(
        "source",
        source,
        ({ input: value }) => ({ change: value.change }),
        {
          session: { type: "isolated" },
        },
      )
      .when(({ input: value }) => value.review)
      .task(
        "decision",
        selected,
        ({ input: value }) => ({ change: value.change }),
        {
          session: ({ tasks }) => branch(tasks.source.session),
        },
      )
      .otherwise(approveTask, ({ input: value }) => ({ change: value.change }))
      .output(({ tasks }) => tasks.decision.output)
      .define();
    const choice = buildWorkflow(workflow).plan.nodes[1];
    expect(choice).toMatchObject({
      type: "choice",
      dependsOn: [],
      then: {
        session: { type: "fork", from: "session-source:1" },
        dependsOn: ["session-source:1"],
      },
    });
  });

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
