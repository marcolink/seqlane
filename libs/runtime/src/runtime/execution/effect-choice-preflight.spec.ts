// @test-scope ./effect-plan.ts
// @test-scope ./effect-choice.ts
// @test-scope ../compile/compile-node-step.ts
// @test-scope ../invocation/invocation-execution.ts
// @test-scope ../session/session-preflight.ts
// @test-scope ../session/session-resolution.ts
// @test-scope ../session/choice-session.ts

import {
  buildWorkflow,
  createFlow,
  defineTask,
  type SeqlaneEvent,
} from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UnsupportedSessionCapabilityError } from "../session/session-preflight.js";
import { UnavailableExecutorModelError } from "../execution/model-preflight.js";
import { Effect, Fiber } from "effect";
import { createEffectPlanProgram } from "./effect-plan.js";

describe("choice preflight lifecycle", () => {
  it("drains an interrupted isolated session acquisition before closing its runtime", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const acquisition = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle: string[] = [];
    const output = z.object({ value: z.string() });
    const execute = vi.fn(async () => ({ value: "unexpected" }));
    const task = defineTask({
      id: "held-session-arm",
      input: z.object({}),
      output,
      execute,
    });
    const workflow = buildWorkflow(
      createFlow({
        id: "held-session-choice",
        input: z.object({ select: z.boolean() }),
        output,
      })
        .when(({ input }) => input.select)
        .task("decision", task, () => ({}), { session: { type: "isolated" } })
        .otherwise(task, () => ({}))
        .output(({ tasks }) => tasks.decision.output)
        .define(),
    );
    const controller = new AbortController();
    const program = createEffectPlanProgram({
      workflow,
      input: { select: true },
      signal: controller.signal,
      workId: "held-work",
      runId: "held-run",
      events: { emit: () => undefined },
      createInvocationId: (nodeId) => nodeId ?? "held-invocation",
      resolveExecution: async () => ({
        taskDefinitions: workflow.taskDefinitions,
        workspaceIdentities: new Map(),
        workspaceResources: new Map(),
        executors: { agent: () => ({ execute }) },
        sessionResolver: {
          resolve: async () => {
            markStarted();
            await acquisition;
            lifecycle.push("acquired");
            return { key: Symbol("late-session"), executor: { execute } };
          },
        },
        close: async () => {
          lifecycle.push("closed");
        },
      }),
    });
    const fiber = Effect.runFork(program);
    await started;
    controller.abort();
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    let settled = false;
    void interrupted.then(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      expect(lifecycle).toEqual([]);
    } finally {
      release();
      await interrupted;
    }
    expect(lifecycle).toEqual(["acquired", "closed"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "resolves only the selected isolated session (condition %s)",
    async (select) => {
      const schema = z.object({ value: z.string() });
      const task = defineTask({
        id: "selected-session",
        input: z.object({}),
        output: schema,
        execute: async ({ context }) =>
          schema.parse(await context.runAgent({ goal: "Return a value" })),
      });
      const model = { provider: "test", model: "available" };
      const built = buildWorkflow(
        createFlow({
          id: "choice-isolated-session",
          input: z.object({ select: z.boolean() }),
          output: schema,
          model: { model },
        })
          .when(({ input }) => input.select)
          .task("decision", task, () => ({}), { session: { type: "isolated" } })
          .otherwise(task, () => ({}), { session: { type: "isolated" } })
          .output(({ tasks }) => tasks.decision.output)
          .define(),
      );
      const execute = vi.fn(async () => ({ value: "session result" }));
      const resolve = vi.fn(async () => ({
        key: Symbol("selected"),
        executor: { execute },
      }));
      const unboundExecutor = vi.fn((): never => {
        throw new Error("Expected the selected session executor");
      });
      const result = await Effect.runPromise(
        createEffectPlanProgram({
          workflow: built,
          input: { select },
          signal: new AbortController().signal,
          workId: "session-work",
          runId: "session-run",
          createInvocationId: (nodeId) => nodeId ?? "session-invocation",
          events: { emit: () => undefined },
          resolveExecution: async () => ({
            taskDefinitions: built.taskDefinitions,
            workspaceIdentities: new Map(),
            workspaceResources: new Map(),
            executors: { agent: unboundExecutor },
            sessionResolver: {
              modelCapabilities: {
                executor: "test",
                listModels: async () => [model],
                resolveDefaultModel: async () => ({ model }),
              },
              resolve,
            },
          }),
        }),
      );
      expect(result).toEqual({
        status: "succeeded",
        output: { value: "session result" },
      });
      expect(resolve).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          invocationId: `choice:1:${select ? "then" : "else"}`,
          effectiveSelection: { model },
        }),
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(unboundExecutor).not.toHaveBeenCalled();
    },
  );

  it.each(["model", "session"] as const)(
    "fails %s preflight without starting or admitting the selected arm",
    async (failure) => {
      const schema = z.object({ value: z.string() });
      const selectedExecute = vi.fn(async () => ({ value: "selected" }));
      const fallbackExecute = vi.fn(async () => ({ value: "fallback" }));
      const selected = defineTask({
        id: "preflight-selected",
        input: z.object({}),
        output: schema,
        execute: selectedExecute,
      });
      const fallback = defineTask({
        id: "preflight-fallback",
        input: z.object({}),
        output: schema,
        execute: fallbackExecute,
      });
      const built = buildWorkflow(
        createFlow({
          id: "choice-preflight",
          input: z.object({ select: z.boolean() }),
          output: schema,
        })
          .when(({ input }) => input.select)
          .task("decision", selected, () => ({}), {
            session: {
              type: "isolated",
              model: {
                model: {
                  provider: "test",
                  model: failure === "model" ? "unavailable" : "available",
                },
              },
            },
          })
          .otherwise(fallback, () => ({}))
          .output(({ tasks }) => tasks.decision.output)
          .define(),
      );
      const executeModel = vi.fn(async () => ({}));
      const resolve = vi.fn(async () => ({
        key: Symbol("selected"),
        executor: { execute: executeModel },
      }));
      const events: SeqlaneEvent[] = [];
      const sink = {
        emit: (event: SeqlaneEvent) => {
          events.push(event);
        },
      };
      const program = createEffectPlanProgram({
        workflow: built,
        input: { select: true },
        signal: new AbortController().signal,
        workId: "preflight-work",
        runId: `preflight-${failure}`,
        createInvocationId: (nodeId) => nodeId ?? "preflight-invocation",
        events: sink,
        resolveExecution: async () => ({
          taskDefinitions: built.taskDefinitions,
          workspaceIdentities: new Map(),
          executors: { agent: () => ({ execute: executeModel }) },
          sessionResolver: {
            adapterCapabilities: {
              execute: true,
              modelSelection: true,
              structuredOutput: false,
              sessionReuse: true,
              checkpoint: true,
              fork: true,
              activity: false,
              sessionUi: false,
            },
            modelCapabilities: {
              executor: "test",
              listModels: async () => [
                { provider: "test", model: "available" },
              ],
              resolveDefaultModel: async () => ({
                model: { provider: "test", model: "available" },
              }),
            },
            resolve,
          },
          workspaceResources: new Map(),
        }),
      });
      await expect(Effect.runPromise(program)).resolves.toMatchObject({
        status: "failed",
      });
      for (const invocationId of ["choice:1:then", "choice:1"]) {
        expect(
          events.filter(
            (event) =>
              event.type === "invocation.failed" &&
              event.invocationId === invocationId,
          ),
        ).toHaveLength(1);
      }
      const failedArm = events.find(
        (event) =>
          event.type === "invocation.failed" &&
          event.invocationId === "choice:1:then",
      );
      if (failedArm?.type !== "invocation.failed")
        throw new Error("Missing arm failure");
      expect(failedArm.error.cause).toBeInstanceOf(
        failure === "model"
          ? UnavailableExecutorModelError
          : UnsupportedSessionCapabilityError,
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: "invocation.started",
          invocationId: "choice:1:then",
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: "invocation.progress",
          invocationId: "choice:1:then",
          phase: "workspace_admitted",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "invocation.skipped",
          invocationId: "choice:1:else",
          reason: "Choice arm not selected",
        }),
      );
      expect(selectedExecute).not.toHaveBeenCalled();
      expect(fallbackExecute).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(executeModel).not.toHaveBeenCalled();
    },
  );
});
