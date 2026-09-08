import type { TaskDefinition, TaskNode } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { createExecutionContext } from "../execution/context.js";
import type { ExecutorRequest } from "../execution/executor.js";
import { executeTaskNode } from "../invocation/invocation-execution.js";
import {
  resolveTaskSession,
  type ResolvedExecutorSession,
  type SessionResolver,
} from "./session-resolution.js";
import { SessionLockRegistry } from "./session-lock.js";

const session: ResolvedExecutorSession = {
  key: Symbol("shared-session"),
  executor: { execute: async () => null },
};

function sharedSessionResolver(
  executor: ResolvedExecutorSession["executor"],
): SessionResolver {
  const shared = { key: Symbol("test-shared-session"), executor };
  return { resolve: async () => shared };
}

async function expectPending(promise: Promise<unknown>) {
  await expect(
    Promise.race([
      promise.then(() => "acquired"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]),
  ).resolves.toBe("pending");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function task(nodeId: string): TaskNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    input: {},
    dependsOn: [],
  };
}

function taskDefinition(taskId: string): TaskDefinition {
  const schema = { parse: (value: unknown) => value };
  return {
    id: taskId,
    workspace: "shared",
    input: schema,
    output: schema,
    goal: () => taskId,
  };
}

describe("exclusive session locks", () => {
  it("waits to admit a second invocation until the first releases its session", async () => {
    const locks = new SessionLockRegistry();
    const first = await locks.acquire(session);
    const waitingSecond = locks.acquire(session);

    await expectPending(waitingSecond);

    first.release();
    const second = await waitingSecond;

    second.release();
  });

  it("grants waiting invocations in creation order", async () => {
    const locks = new SessionLockRegistry();
    const active = await locks.acquire(session);
    const later = locks.acquire(session, undefined, 2);
    const earlier = locks.acquire(session, undefined, 1);

    active.release();
    const firstAdmitted = await Promise.race([
      earlier.then((lease) => ({ invocation: "earlier", lease })),
      later.then((lease) => ({ invocation: "later", lease })),
    ]);

    expect(firstAdmitted.invocation).toBe("earlier");
    firstAdmitted.lease.release();
    (await later).release();
  });

  it("rejects queued invocations when a session is quarantined", async () => {
    const locks = new SessionLockRegistry();
    const active = await locks.acquire(session);
    const waiting = locks.acquire(session);

    await expectPending(waiting);

    const terminationFailure = new Error("termination unconfirmed");
    locks.quarantine(session, terminationFailure);

    await expect(waiting).rejects.toMatchObject({
      name: "QuarantinedSessionError",
      cause: terminationFailure,
    });
    active.release();
    await expect(locks.acquire(session)).rejects.toMatchObject({
      name: "QuarantinedSessionError",
      cause: terminationFailure,
    });
  });

  it("removes a cancelled invocation from the session queue", async () => {
    const locks = new SessionLockRegistry();
    const active = await locks.acquire(session);
    const controller = new AbortController();
    const waiting = locks.acquire(
      session,
      undefined,
      Number.MAX_SAFE_INTEGER,
      controller.signal,
    );

    await expectPending(waiting);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");

    active.release();
    const next = await locks.acquire(session);
    next.release();
  });

  it("releases a failed shared session before marking a waiting task active", async () => {
    const activeInvocations: string[] = [];
    const firstExecutorStarted = deferred<void>();
    const finishFirstExecutor = deferred<void>();
    const executor = {
      execute: async ({ invocationId }: ExecutorRequest) => {
        if (invocationId === "first") {
          firstExecutorStarted.resolve();
          await finishFirstExecutor.promise;
          throw new Error("first task failed");
        }
        return { invocationId };
      },
    };
    const sessionResolver = sharedSessionResolver(executor);
    const taskDefinitions = new Map([
      ["first", taskDefinition("first")],
      ["second", taskDefinition("second")],
    ]);
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver,
      taskDefinitions,
      events: {
        emit: (event) => {
          if (event.type === "invocation.started") {
            activeInvocations.push(event.invocationId);
          }
        },
      },
    });
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      taskDefinitions,
      "first",
      "first",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      taskDefinitions,
      "second",
      "second",
    );

    const abortSignal = new AbortController().signal;
    const first = executeTaskNode(context, task("first"), abortSignal, {
      invocationId: "first",
      observability: {},
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "first" },
    });
    await firstExecutorStarted.promise;

    const second = executeTaskNode(context, task("second"), abortSignal, {
      invocationId: "second",
      observability: {},
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "second" },
    });

    await expectPending(second);
    expect(activeInvocations).toEqual(["first"]);

    finishFirstExecutor.resolve();
    await expect(first).rejects.toThrow(/first task failed/i);
    await second;

    expect(activeInvocations).toEqual(["first", "second"]);
  });

  it("keeps a shared session unavailable while a child session is active", async () => {
    const childTerminated = deferred<void>();
    const firstResponseCompleted = deferred<void>();
    const secondExecutorStarted = deferred<void>();
    const executor = {
      execute: async (request: ExecutorRequest) => {
        if (request.invocationId === "first") {
          request.onChildSession?.({
            termination: childTerminated.promise,
          });
          firstResponseCompleted.resolve();
        } else {
          secondExecutorStarted.resolve();
        }
        return {};
      },
    };
    const sessionResolver = sharedSessionResolver(executor);
    const taskDefinitions = new Map([
      ["first", taskDefinition("first")],
      ["second", taskDefinition("second")],
    ]);
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver,
      taskDefinitions,
    });
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      taskDefinitions,
      "first",
      "first",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      taskDefinitions,
      "second",
      "second",
    );

    const abortSignal = new AbortController().signal;
    const first = executeTaskNode(context, task("first"), abortSignal, {
      invocationId: "first",
      observability: {},
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "first" },
    });
    await firstResponseCompleted.promise;

    const second = executeTaskNode(context, task("second"), abortSignal, {
      invocationId: "second",
      observability: {},
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "second" },
    });
    await expectPending(secondExecutorStarted.promise);

    childTerminated.resolve();
    await first;
    await secondExecutorStarted.promise;
    await second;
  });

  it("keeps a shared session unavailable after cancellation until termination confirms", async () => {
    const terminationConfirmed = deferred<void>();
    const firstExecutorStarted = deferred<void>();
    const abortRequested = deferred<void>();
    const secondExecutorStarted = deferred<void>();
    const executor = {
      execute: async (request: ExecutorRequest) => {
        if (request.invocationId === "first") {
          firstExecutorStarted.resolve();
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              "abort",
              () => {
                abortRequested.resolve();
                terminationConfirmed.promise.then(resolve);
              },
              { once: true },
            );
          });
          throw new Error("executor terminated");
        }
        secondExecutorStarted.resolve();
        return {};
      },
    };
    const sessionResolver = sharedSessionResolver(executor);
    const taskDefinitions = new Map([
      ["first", taskDefinition("first")],
      ["second", taskDefinition("second")],
    ]);
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver,
      taskDefinitions,
    });
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      taskDefinitions,
      "first",
      "first",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      taskDefinitions,
      "second",
      "second",
    );

    const controller = new AbortController();
    const first = executeTaskNode(context, task("first"), controller.signal, {
      invocationId: "first",
      observability: {},
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "first" },
    });
    await firstExecutorStarted.promise;
    controller.abort();
    await abortRequested.promise;

    const second = executeTaskNode(
      context,
      task("second"),
      new AbortController().signal,
      {
        invocationId: "second",
        observability: {},
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "second" },
      },
    );
    await expectPending(secondExecutorStarted.promise);

    terminationConfirmed.resolve();
    await expect(first).rejects.toThrow("executor terminated");
    await secondExecutorStarted.promise;
    await second;
  });

  it("rejects a later invocation after the shared session is quarantined", async () => {
    let secondExecutorCalled = false;
    const executor = {
      execute: async (request: ExecutorRequest) => {
        if (request.invocationId === "first") {
          request.onUncertainActivity?.({ reason: "disconnect" });
          return {};
        }
        secondExecutorCalled = true;
        return {};
      },
    };
    const sessionResolver = sharedSessionResolver(executor);
    const taskDefinitions = new Map([
      ["first", taskDefinition("first")],
      ["second", taskDefinition("second")],
    ]);
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver,
      taskDefinitions,
    });
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      taskDefinitions,
      "first",
      "first",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      taskDefinitions,
      "second",
      "second",
    );

    await expect(
      executeTaskNode(context, task("first"), new AbortController().signal, {
        invocationId: "first",
        observability: {},
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "first" },
      }),
    ).rejects.toThrow("termination");

    const second = executeTaskNode(
      context,
      task("second"),
      new AbortController().signal,
      {
        invocationId: "second",
        observability: {},
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "second" },
      },
    );
    await expect(
      Promise.race([
        second.then(
          () => "completed",
          () => "rejected",
        ),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
      ]),
    ).resolves.toBe("rejected");
    expect(secondExecutorCalled).toBe(false);
  });
});
