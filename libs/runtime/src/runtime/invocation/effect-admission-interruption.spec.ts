// @test-scope ./task-admission.ts
// @test-scope ./joint-admission.ts
// @test-scope ../session/session-lock.ts
// @test-scope ../workspace/workspace-lock.ts
// @test-scope ../execution/context.ts
// @test-scope ../execution/executor.ts
// @test-scope ../session/session-resolution.ts
// @test-scope ../workspace/workspace-resource.ts
// @test-scope ../execution/await-abort.ts
import { defineTask, type TaskNode } from "@seqlane/core";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createExecutionContext } from "../execution/context.js";
import {
  findUnconfirmedInvocationTermination,
  type ExecutorRequest,
} from "../execution/executor.js";
import type { ResolvedExecutorSession } from "../session/session-resolution.js";
import { SessionLockRegistry } from "../session/session-lock.js";
import { executeTaskNodeEffect } from "./task-admission.js";
import { WorkspaceLockRegistry } from "../workspace/workspace-lock.js";

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

const sessionExecutor = { execute: async () => ({}) };
const resolvedSession: ResolvedExecutorSession = {
  key: Symbol("shared-session"),
  executor: sessionExecutor,
};

describe("Effect admission interruption", () => {
  it("settles a fiber-interrupted session waiter before the held lease releases", async () => {
    const locks = new SessionLockRegistry();
    const active = await Effect.runPromise(
      locks.acquireEffect(resolvedSession),
    );
    const queued = barrier();
    const waiter = Effect.runFork(
      locks.acquireEffect(resolvedSession, () => queued.resolve(), 1),
    );

    try {
      await queued.promise;
      await Effect.runPromise(Fiber.interrupt(waiter));

      active.release();
      const next = await Effect.runPromise(
        locks.acquireEffect(resolvedSession),
      );
      next.release();
    } finally {
      active.release();
    }
  });

  it("removes an interrupted exclusive workspace head while shared work remains active", async () => {
    const locks = new WorkspaceLockRegistry();
    const workspace = { key: "/effect-interrupt-shared-workspace" };
    const activeShared = await Effect.runPromise(
      locks.acquireEffect(workspace, "shared", undefined, 0, "active-reader"),
    );
    const exclusiveQueued = barrier();
    const exclusive = Effect.runFork(
      locks.acquireEffect(
        workspace,
        "exclusive",
        () => exclusiveQueued.resolve(),
        1,
        "exclusive-head",
      ),
    );

    try {
      await exclusiveQueued.promise;
      await Effect.runPromise(Fiber.interrupt(exclusive));

      const compatible = await Effect.runPromise(
        locks.acquireEffect(workspace, "shared", undefined, 2, "later-reader"),
      );
      expect(locks.isAvailable(workspace, "exclusive")).toBe(false);
      compatible.release();
      activeShared.release();
    } finally {
      activeShared.release();
    }
  });

  it("holds task session and workspace admission until interrupted SDK cleanup settles", async () => {
    const inputSchema = z.object({ payload: z.string() });
    const outputSchema = z.object({ result: z.string() });
    const taskDefinition = defineTask({
      id: "effect-interruption-task",
      input: inputSchema,
      output: outputSchema,
      execute: async ({ input, context }) => {
        const result = await context.runAgent({
          goal: `process ${input.payload}`,
        });
        return outputSchema.parse(result);
      },
    });
    const executionStarted = barrier<ExecutorRequest>();
    const signalAborted = barrier<void>();
    const releaseSdkCleanup = barrier<void>();
    const workspace = { key: "/effect-interrupt-task-workspace" };
    const events: string[] = [];
    const executor = {
      execute: async (request: ExecutorRequest) => {
        executionStarted.resolve(request);
        request.signal.addEventListener(
          "abort",
          () => signalAborted.resolve(),
          {
            once: true,
          },
        );
        await releaseSdkCleanup.promise;
        return outputSchema.parse({ result: "finished" });
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([[taskDefinition.id, executor]]),
      taskDefinitions: new Map([[taskDefinition.id, taskDefinition]]),
      workspaceResources: new Map([[taskDefinition.id, workspace]]),
      events: {
        emit: (event) => {
          if (
            event.type === "invocation.started" ||
            event.type === "invocation.succeeded"
          )
            events.push(event.type);
        },
      },
    });
    const session: ResolvedExecutorSession = {
      key: Symbol("task-session"),
      executor,
    };
    context.resolvedSessions.set("effect-interruption-invocation", session);
    const node: TaskNode = {
      type: "task",
      taskId: taskDefinition.id,
      nodeId: "effect-interruption-node",
      workspace: "exclusive",
      input: { payload: "typed input" },
      dependsOn: [],
    };
    const taskFiber = Effect.runFork(
      executeTaskNodeEffect(
        context,
        node,
        new AbortController().signal,
        {
          invocationId: "effect-interruption-invocation",
          observability: {},
          results: context.results,
          remainingConsumers: context.remainingConsumers,
          subject: { type: "task", taskId: taskDefinition.id },
        },
        (effect) => effect,
      ),
    );

    const taskRequest = await executionStarted.promise;
    expect(taskRequest.input).toEqual({ payload: "typed input" });
    expect(taskRequest.agent?.goal).toBe("process typed input");
    expect(events).toContain("invocation.started");

    const interruption = Effect.runPromise(Fiber.interrupt(taskFiber));
    try {
      await signalAborted.promise;
      const conflictQueued = barrier<void>();
      const conflictFiber = Effect.runFork(
        context.workspaceLocks.acquireEffect(
          workspace,
          "exclusive",
          () => conflictQueued.resolve(),
          1,
          "conflicting-invocation",
        ),
      );
      const sessionConflictQueued = barrier<void>();
      const sessionConflictFiber = Effect.runFork(
        context.sessionLocks.acquireEffect(
          session,
          () => sessionConflictQueued.resolve(),
          2,
        ),
      );
      await conflictQueued.promise;
      await sessionConflictQueued.promise;
      await expectPending(interruption);
      await expectPending(Effect.runPromise(Fiber.join(conflictFiber)));
      await expectPending(Effect.runPromise(Fiber.join(sessionConflictFiber)));
      expect(context.sessionLocks.isAvailable(session)).toBe(false);
      expect(events).not.toContain("invocation.succeeded");

      releaseSdkCleanup.resolve();
      await interruption;
      const conflictLease = await Effect.runPromise(Fiber.join(conflictFiber));
      conflictLease.release();
      const sessionConflictLease = await Effect.runPromise(
        Fiber.join(sessionConflictFiber),
      );
      sessionConflictLease.release();
      expect(context.sessionLocks.isAvailable(session)).toBe(true);
    } finally {
      releaseSdkCleanup.resolve();
    }
  });

  it("quarantines an invocation after bounded interrupted cleanup and retains a late SDK failure", async () => {
    const inputSchema = z.object({ payload: z.string() });
    const outputSchema = z.object({ result: z.string() });
    const taskDefinition = defineTask({
      id: "effect-interruption-timeout-task",
      input: inputSchema,
      output: outputSchema,
      execute: async ({ input, context }) =>
        outputSchema.parse(
          await context.runAgent({ goal: `process ${input.payload}` }),
        ),
    });
    const executionStarted = barrier<ExecutorRequest>();
    const sdkFailure = new Error("late SDK rejection");
    let rejectSdk!: (cause: unknown) => void;
    const workspace = { key: "/effect-interrupt-timeout-workspace" };
    const executor = {
      execute: (request: ExecutorRequest) => {
        executionStarted.resolve(request);
        return new Promise<unknown>((_resolve, reject) => {
          rejectSdk = reject;
        });
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([[taskDefinition.id, executor]]),
      taskDefinitions: new Map([[taskDefinition.id, taskDefinition]]),
      workspaceResources: new Map([[taskDefinition.id, workspace]]),
      events: { emit: () => undefined },
    });
    const session: ResolvedExecutorSession = {
      key: Symbol("timed-out-task-session"),
      executor,
    };
    context.resolvedSessions.set(
      "effect-interrupt-timeout-invocation",
      session,
    );
    const node: TaskNode = {
      type: "task",
      taskId: taskDefinition.id,
      nodeId: "effect-interrupt-timeout-node",
      workspace: "exclusive",
      input: { payload: "typed input" },
      dependsOn: [],
    };
    const taskFiber = Effect.runFork(
      executeTaskNodeEffect(
        context,
        node,
        new AbortController().signal,
        {
          invocationId: "effect-interrupt-timeout-invocation",
          results: context.results,
          remainingConsumers: context.remainingConsumers,
          subject: { type: "task", taskId: taskDefinition.id },
        },
        (effect) => effect,
        undefined,
        2,
      ),
    );
    const request = await executionStarted.promise;
    const exit = await Effect.runPromise(
      Fiber.interrupt(taskFiber).pipe(Effect.andThen(Fiber.await(taskFiber))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(request.signal.aborted).toBe(true);
    expect(() =>
      context.workspaceLocks.isAvailable(workspace, "exclusive"),
    ).toThrow("Workspace is quarantined for this Run");
    expect(() => context.sessionLocks.isAvailable(session)).toThrow(
      "Executor session is quarantined for this Run",
    );

    const unrelatedWorkspace = { key: "/effect-interrupt-timeout-unrelated" };
    const unrelated = await Effect.runPromise(
      context.workspaceLocks.acquireEffect(unrelatedWorkspace, "exclusive"),
    );
    unrelated.release();

    rejectSdk(sdkFailure);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    const uncertain = findUnconfirmedInvocationTermination(failure);
    expect(uncertain).toBeDefined();
    expect(uncertain?.cause).toBe(sdkFailure);
  });

  it("bounds an unresolved started activity and withholds success", async () => {
    const inputSchema = z.object({ payload: z.string() });
    const outputSchema = z.object({ result: z.string() });
    const taskDefinition = defineTask({
      id: "effect-unresolved-activity-task",
      input: inputSchema,
      output: outputSchema,
      execute: async ({ input, context }) =>
        outputSchema.parse(
          await context.runAgent({ goal: `process ${input.payload}` }),
        ),
    });
    const never = new Promise<void>(() => undefined);
    const trackedFailure = new Error("tracked child failed late");
    const workspace = { key: "/effect-unresolved-activity-workspace" };
    const events: string[] = [];
    const executor = {
      execute: async (request: ExecutorRequest) => {
        request.onEffect?.({ type: "child", termination: never });
        request.onEffect?.({
          type: "process",
          termination: Promise.reject(trackedFailure),
        });
        return { result: "must not publish" };
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([[taskDefinition.id, executor]]),
      taskDefinitions: new Map([[taskDefinition.id, taskDefinition]]),
      workspaceResources: new Map([[taskDefinition.id, workspace]]),
      events: {
        emit: (event) => {
          if (
            event.type === "invocation.succeeded" ||
            event.type === "invocation.failed"
          )
            events.push(event.type);
        },
      },
    });
    const session: ResolvedExecutorSession = {
      key: Symbol("unresolved-activity-session"),
      executor,
    };
    context.resolvedSessions.set(
      "effect-unresolved-activity-invocation",
      session,
    );
    const node: TaskNode = {
      type: "task",
      taskId: taskDefinition.id,
      nodeId: "effect-unresolved-activity-node",
      workspace: "exclusive",
      input: { payload: "typed input" },
      dependsOn: [],
    };
    const fiber = Effect.runFork(
      executeTaskNodeEffect(
        context,
        node,
        new AbortController().signal,
        {
          invocationId: "effect-unresolved-activity-invocation",
          terminationTimeoutMs: 2,
          results: context.results,
          remainingConsumers: context.remainingConsumers,
          subject: { type: "task", taskId: taskDefinition.id },
        },
        (effect) => effect,
        undefined,
        100,
      ),
    );

    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    const uncertainty = findUnconfirmedInvocationTermination(failure);
    expect(uncertainty).toBeDefined();
    expect(uncertainty?.cause).toBeInstanceOf(Error);
    expect(uncertainty?.cause).toMatchObject({ cause: trackedFailure });
    expect(events).not.toContain("invocation.succeeded");
    expect(() =>
      context.workspaceLocks.isAvailable(workspace, "exclusive"),
    ).toThrow("Workspace is quarantined for this Run");
    expect(() => context.sessionLocks.isAvailable(session)).toThrow(
      "Executor session is quarantined for this Run",
    );
  });

  it("does not apply the cleanup bound to healthy task execution", async () => {
    const inputSchema = z.object({ payload: z.string() });
    const outputSchema = z.object({ result: z.string() });
    const taskDefinition = defineTask({
      id: "effect-healthy-long-task",
      input: inputSchema,
      output: outputSchema,
      execute: async ({ input, context }) =>
        outputSchema.parse(
          await context.runAgent({ goal: `process ${input.payload}` }),
        ),
    });
    const executor = {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { result: "finished" };
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([[taskDefinition.id, executor]]),
      taskDefinitions: new Map([[taskDefinition.id, taskDefinition]]),
      events: { emit: () => undefined },
    });
    const node: TaskNode = {
      type: "task",
      taskId: taskDefinition.id,
      nodeId: "effect-healthy-long-node",
      workspace: "exclusive",
      input: { payload: "typed input" },
      dependsOn: [],
    };
    const exit = await Effect.runPromise(
      Fiber.await(
        Effect.runFork(
          executeTaskNodeEffect(
            context,
            node,
            new AbortController().signal,
            {
              invocationId: "effect-healthy-long-invocation",
              terminationTimeoutMs: 2,
              results: context.results,
              remainingConsumers: context.remainingConsumers,
              subject: { type: "task", taskId: taskDefinition.id },
            },
            (effect) => effect,
            undefined,
            2,
          ),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
