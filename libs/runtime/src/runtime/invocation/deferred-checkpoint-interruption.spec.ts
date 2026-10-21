// @test-scope ./task-admission.ts
// @test-scope ./deferred-task-completion.ts
// @test-scope ./invocation-execution.ts
// @test-scope ../session/session-lock.ts
// @test-scope ../workspace/workspace-lock.ts
// @test-scope ../execution/context.ts
// @test-scope ../execution/executor.ts
// @test-scope ../session/session-resolution.ts
import { defineTask, defineValidator, type SeqlaneEvent } from "@seqlane/core";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createExecutionContext } from "../execution/context.js";
import type { ExecutorRequest } from "../execution/executor.js";
import type { ResolvedExecutorSession } from "../session/session-resolution.js";
import { completeValidatedTaskEffect } from "./deferred-task-completion.js";
import { executeTaskNodeEffect } from "./task-admission.js";

function barrier<A = void>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

const inputSchema = z.object({ value: z.string() });
const outputSchema = z.object({ result: z.string() });

function createTask() {
  return defineTask({
    id: "deferred-checkpoint-task",
    input: inputSchema,
    output: outputSchema,
    execute: ({ input, context }) => context.runAgent({ goal: input.value }),
  });
}

describe("deferred task completion ownership", () => {
  it("keeps the session lease through an interrupted checkpoint after releasing workspace admission", async () => {
    const task = createTask();
    const executor = {
      execute: async () => ({ result: "done" }),
    };
    const checkpointStarted = barrier<void>();
    const releaseCheckpoint = barrier<void>();
    const workspace = { key: "/deferred-checkpoint-workspace" };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([[task.id, executor]]),
      taskDefinitions: new Map([[task.id, task]]),
      workspaceResources: new Map([[task.id, workspace]]),
    });
    const session: ResolvedExecutorSession = {
      key: Symbol("deferred-checkpoint-session"),
      executor,
      checkpoint: async () => {
        checkpointStarted.resolve();
        await releaseCheckpoint.promise;
        return { checkpoint: "captured" };
      },
      fork: async () => ({ key: Symbol("forked-session"), executor }),
    };
    context.resolvedSessions.set("invocation", session);
    context.sessionConsumers.set("node", []);
    context.sessionConsumers.set("node", [
      { invocationId: "fork-consumer", task, type: "fork" },
    ]);
    const node = {
      type: "task" as const,
      taskId: task.id,
      nodeId: "node",
      workspace: "exclusive" as const,
      input: { value: "run" },
      dependsOn: [],
    };
    const owner = Effect.runFork(
      executeTaskNodeEffect(
        context,
        node,
        new AbortController().signal,
        {
          invocationId: "invocation",
          observability: {},
          results: context.results,
          remainingConsumers: context.remainingConsumers,
          subject: { type: "task", taskId: task.id },
          deferCompletion: true,
        },
        (effect) => effect,
        completeValidatedTaskEffect({
          context,
          node,
          invocationId: "invocation",
          abortSignal: new AbortController().signal,
          withBodyPermit: (effect) => effect,
        }),
      ),
    );

    await checkpointStarted.promise;
    expect(context.workspaceLocks.isAvailable(workspace, "exclusive")).toBe(
      true,
    );
    const queued = barrier<void>();
    const contender = Effect.runFork(
      context.sessionLocks.acquireEffect(session, () => queued.resolve(), 1),
    );
    await queued.promise;
    const interruption = Effect.runPromise(Fiber.interrupt(owner));
    try {
      await expectPending(interruption);
      expect(context.sessionLocks.isAvailable(session)).toBe(false);
      await expectPending(Effect.runPromise(Fiber.join(contender)));

      releaseCheckpoint.resolve();
      await interruption;
      const lease = await Effect.runPromise(Fiber.join(contender));
      lease.release();
      expect(context.sessionLocks.isAvailable(session)).toBe(true);
    } finally {
      releaseCheckpoint.resolve();
    }
  });

  it("publishes paid task metrics when deferred output validation fails", async () => {
    const task = createTask();
    const metrics = {
      durationMs: 0,
      model: "paid-model",
      provider: "test-provider",
      cost: 0,
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
    const executor = {
      execute: async (request: ExecutorRequest) => {
        request.onMetrics?.(metrics);
        return { result: "paid output" };
      },
    };
    const events: SeqlaneEvent[] = [];
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([[task.id, executor]]),
      taskDefinitions: new Map([[task.id, task]]),
      validatorDefinitions: new Map([
        [
          "reject",
          defineValidator({
            id: "reject",
            input: z.unknown(),
            validate: () => ({
              success: false as const,
              issues: [{ code: "rejected", message: "output rejected" }],
            }),
          }),
        ],
      ]),
      events: { emit: (event) => events.push(event) },
    });
    const node = {
      type: "task" as const,
      taskId: task.id,
      nodeId: "node",
      workspace: "exclusive" as const,
      input: { value: "run" },
      dependsOn: [],
    };
    const abortSignal = new AbortController().signal;
    const effect = executeTaskNodeEffect(
      context,
      node,
      abortSignal,
      {
        invocationId: "invocation",
        observability: {},
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: task.id },
        deferCompletion: true,
      },
      (body) => body,
      completeValidatedTaskEffect({
        context,
        node,
        invocationId: "invocation",
        validation: { source: { type: "mechanical", validatorId: "reject" } },
        abortSignal,
        withBodyPermit: (body) => body,
      }),
    );

    await expect(Effect.runPromise(effect)).rejects.toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.output",
        policy: "persistent",
        metrics,
      }),
    );
    expect(context.deferredTaskMetrics.has("invocation")).toBe(false);
  });
});
