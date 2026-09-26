// @test-scope ./mastra-choice-compiler.ts
// @test-scope ./mastra-plan-compiler.ts
// @test-scope ../validation/plan-validation.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ChoiceNode,
  Plan,
  SeqlaneEvent,
  TaskDefinition,
} from "@seqlane/core";
import { compilePlanToMastra } from "./mastra-plan-compiler.js";
import { createMastraRuntime } from "../mastra/mastra-runtime.js";
import {
  PlanValidationError,
  validatePlan,
} from "../validation/plan-validation.js";

const input = z.object({ chooseReview: z.boolean(), change: z.string() });
const review = z.object({ kind: z.literal("review"), risk: z.number() });
const approval = z.object({ kind: z.literal("approval"), reason: z.string() });
const output = z.discriminatedUnion("kind", [review, approval]);
const armInput = z.object({ change: z.string() });

const definitions = new Map<string, TaskDefinition>([
  [
    "review",
    {
      id: "review",
      input: armInput,
      output: review,
      execute: async () => ({ kind: "review", risk: 1 }),
    },
  ],
  [
    "approval",
    {
      id: "approval",
      input: armInput,
      output: approval,
      execute: async () => ({ kind: "approval", reason: "normal" }),
    },
  ],
]);

const plan: Plan = {
  workflow: { id: "choice-compiler-test" },
  nodes: [
    {
      type: "choice",
      nodeId: "choice:1",
      condition: {
        type: "ref",
        nodeId: "__seqlane_input",
        path: ["chooseReview"],
      },
      then: {
        type: "task",
        taskId: "review",
        nodeId: "choice:1:then",
        workspace: "shared",
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
        taskId: "approval",
        nodeId: "choice:1:else",
        workspace: "shared",
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
  ],
  output: { type: "ref", nodeId: "choice:1", path: ["output"] },
};

describe("Mastra exclusive choice", () => {
  it("rejects out-of-scope arm references in a serialized Plan", () => {
    const choice = plan.nodes[0] as ChoiceNode;
    const invalid: Plan = {
      ...plan,
      nodes: [
        {
          ...choice,
          then: {
            ...choice.then,
            input: {
              change: {
                type: "ref",
                nodeId: choice.else.nodeId,
                path: ["output"],
              },
            },
          },
        },
      ],
    };
    expect(() => validatePlan(invalid, definitions)).toThrow(
      PlanValidationError,
    );
    try {
      validatePlan(invalid, definitions);
    } catch (error) {
      expect(error).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "invalid-choice-arm-reference" }),
        ]),
      });
    }
  });

  it("fails a non-Boolean condition before either arm runs", async () => {
    const invoked: string[] = [];
    const events: SeqlaneEvent[] = [];
    const compiled = compilePlanToMastra(plan, {
      taskDefinitions: definitions,
      workflow: {
        input: z.object({ chooseReview: z.unknown(), change: z.string() }),
        output,
      },
      events: { emit: (event) => events.push(event) },
      executeInvocation: async ({ node }) => {
        invoked.push(node.nodeId);
        return { kind: "review", risk: 1 };
      },
    });
    const runtime = createMastraRuntime([
      { key: compiled.key, workflow: compiled.workflow },
    ]);
    await expect(
      runtime.run({
        workflowKey: compiled.key,
        input: { chooseReview: "yes", change: "a" },
        workId: "invalid-choice-work",
        runId: "invalid-choice-run",
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(invoked).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.failed",
        invocationId: "choice-compiler-test:choice:1",
      }),
    );
    expect(
      events.filter((event) => event.type === "invocation.skipped"),
    ).toHaveLength(2);
  });

  it.each([
    [true, "review", { kind: "review", risk: 1 }, "choice:1:else"],
    [
      false,
      "approval",
      { kind: "approval", reason: "normal" },
      "choice:1:then",
    ],
  ])(
    "runs only the selected arm when condition is %s",
    async (condition, selected, expected, unselectedId) => {
      const invoked: string[] = [];
      const events: unknown[] = [];
      const compiled = compilePlanToMastra(plan, {
        taskDefinitions: definitions,
        workflow: { input, output },
        events: { emit: (event) => events.push(event) },
        executeInvocation: async ({ node, input: selectedInput }) => {
          invoked.push(node.nodeId);
          expect(selectedInput).toEqual({ change: "a" });
          return selected === "review"
            ? { kind: "review", risk: 1 }
            : { kind: "approval", reason: "normal" };
        },
      });
      const runtime = createMastraRuntime([
        { key: compiled.key, workflow: compiled.workflow },
      ]);

      await expect(
        runtime.run({
          workflowKey: compiled.key,
          input: { chooseReview: condition, change: "a" },
          workId: "work-choice",
          runId: `run-choice-${condition}`,
        }),
      ).resolves.toEqual({ status: "succeeded", result: expected });
      expect(invoked).toEqual([`choice:1:${condition ? "then" : "else"}`]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.skipped",
          reason: "Choice arm not selected",
          invocationId: `choice-compiler-test:${unselectedId}`,
        }),
      );
    },
  );
});
