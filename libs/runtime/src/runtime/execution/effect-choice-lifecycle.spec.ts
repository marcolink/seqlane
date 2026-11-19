// @test-scope ./effect-plan.ts
// @test-scope ./effect-choice.ts
// @test-scope ./workflow-run.ts
// @test-scope ./run-sequential-graph.ts
// @test-scope ../compile/compile-node-step.ts
// @test-scope ../validation/plan-validation.ts

import {
  buildWorkflow,
  createFlow,
  defineTask,
  type BuiltWorkflow,
  type SeqlaneEvent,
} from "@seqlane/core";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEffectPlanProgram } from "./effect-plan.js";
import {
  PlanValidationError,
  validatePlan,
} from "../validation/plan-validation.js";

function runChoice(
  workflow: BuiltWorkflow,
  input: unknown,
  events: SeqlaneEvent[],
  signal = new AbortController().signal,
) {
  return Effect.runPromise(
    createEffectPlanProgram({
      workflow,
      input,
      workId: "choice-work",
      runId: "choice-run",
      signal,
      events: { emit: (event) => events.push(event) },
      createInvocationId: (nodeId) => nodeId ?? "choice-invocation",
      resolveExecution: async () => ({
        taskDefinitions: workflow.taskDefinitions,
        workspaceIdentities: new Map(),
        workspaceResources: new Map(),
        executors: {
          agent: () => {
            throw new Error("Unexpected model call");
          },
        },
        sessionResolver: {
          resolve: async () => {
            throw new Error("Unexpected session acquisition");
          },
        },
      }),
    }),
  );
}

describe("native choice failure lifecycle", () => {
  const schema = z.object({ value: z.string() });

  it.each(["yes", 1, 0, null])(
    "rejects non-Boolean condition %j before executing an arm",
    async (select) => {
      const execute = vi.fn(async () => ({ value: "unexpected" }));
      const task = defineTask({
        id: "boolean-arm",
        input: z.object({}),
        output: schema,
        execute,
      });
      const built = buildWorkflow(
        createFlow({
          id: "boolean-choice",
          input: z.object({ select: z.boolean() }),
          output: schema,
        })
          .when(({ input }) => input.select)
          .task("decision", task, () => ({}))
          .otherwise(task, () => ({}))
          .output(({ tasks }) => tasks.decision.output)
          .define(),
      );
      // Serialized bindings can read values whose runtime schema is unknown.
      const workflow = {
        ...built,
        workflow: {
          ...built.workflow,
          input: z.object({ select: z.unknown() }),
        },
      };
      const events: SeqlaneEvent[] = [];
      await expect(
        runChoice(workflow, { select }, events),
      ).resolves.toMatchObject({ status: "failed" });
      expect(execute).not.toHaveBeenCalled();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.failed",
          invocationId: "choice:1",
        }),
      );
      for (const arm of ["then", "else"]) {
        expect(
          events.filter(
            (event) =>
              event.type === "invocation.skipped" &&
              event.invocationId === `choice:1:${arm}`,
          ),
        ).toHaveLength(1);
      }
    },
  );

  it.each(["failure", "cancellation"] as const)(
    "settles both unstarted arms after dependency %s",
    async (mode) => {
      let started!: () => void;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      const condition = defineTask({
        id: "condition",
        input: z.object({}),
        output: z.object({ select: z.boolean() }),
        execute: async ({ signal }) => {
          started();
          if (mode === "failure") throw new Error("condition failed");
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      });
      const execute = vi.fn(async () => ({ value: "unexpected" }));
      const arm = defineTask({
        id: "unstarted-arm",
        input: z.object({}),
        output: schema,
        execute,
      });
      const built = buildWorkflow(
        createFlow({
          id: "unstarted-choice",
          input: z.object({}),
          output: schema,
        })
          .task("condition", condition, () => ({}))
          .when(({ tasks }) => tasks.condition.output.select)
          .task("decision", arm, () => ({}))
          .otherwise(arm, () => ({}))
          .output(({ tasks }) => tasks.decision.output)
          .define(),
      );
      const events: SeqlaneEvent[] = [];
      const controller = new AbortController();
      const outcome = runChoice(built, {}, events, controller.signal);
      await start;
      if (mode === "cancellation") controller.abort();
      await expect(outcome).resolves.toMatchObject({
        status: mode === "failure" ? "failed" : "cancelled",
      });
      for (const armName of ["then", "else"]) {
        const id = `choice:1:${armName}`;
        expect(
          events.filter(
            (event) =>
              event.type ===
                (mode === "failure"
                  ? "invocation.skipped"
                  : "invocation.cancelled") && event.invocationId === id,
          ),
        ).toHaveLength(1);
        expect(events).not.toContainEqual(
          expect.objectContaining({
            type: "invocation.started",
            invocationId: id,
          }),
        );
      }
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rejects a serialized binding from one arm to the other arm", () => {
    const task = defineTask({
      id: "scoped-arm",
      input: schema,
      output: schema,
      execute: async ({ input }) => input,
    });
    const built = buildWorkflow(
      createFlow({
        id: "scoped-choice",
        input: z.object({ select: z.boolean(), value: z.string() }),
        output: schema,
      })
        .when(({ input }) => input.select)
        .task("decision", task, ({ input }) => ({ value: input.value }))
        .otherwise(task, ({ input }) => ({ value: input.value }))
        .output(({ tasks }) => tasks.decision.output)
        .define(),
    );
    const node = built.plan.nodes[0];
    if (node?.type !== "choice") throw new Error("Expected choice node");
    const invalid = {
      ...built.plan,
      nodes: [
        {
          ...node,
          then: {
            ...node.then,
            input: {
              type: "ref" as const,
              nodeId: node.else.nodeId,
              path: ["output"],
            },
          },
        },
      ],
    };
    expect(() => validatePlan(invalid, built.taskDefinitions)).toThrow(
      PlanValidationError,
    );
    try {
      validatePlan(invalid, built.taskDefinitions);
    } catch (error) {
      expect(error).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "invalid-choice-arm-reference" }),
        ]),
      });
    }
  });
});
