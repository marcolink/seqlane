// @test-scope ../execution/context.ts
// @test-scope ../session/child-session.ts
// @test-scope ../execution/executor.ts
// @test-scope ../invocation/invocation-effects.ts
// @test-scope ../invocation/invocation-execution.ts
// @test-scope ../session/session-lock.ts
// @test-scope ../session/session-resolution.ts
// @test-scope ./workspace-lock.ts
// @test-scope ./workspace-resource.ts
import {
  ExecutorError,
  type TaskDefinition,
  type TaskNode,
} from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { createExecutionContext } from "../execution/context.js";
import {
  type ExecutorRequest,
  UnconfirmedInvocationTerminationError,
} from "../execution/executor.js";
import { executeTaskNode } from "../invocation/invocation-execution.js";
import { resolveTaskSession } from "../session/session-resolution.js";
import type { WorkspaceResource } from "./workspace-resource.js";

const schema = { parse: (value: unknown) => value };
const workspace: WorkspaceResource = { key: "/checkout" };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>) {
  await expect(
    Promise.race([
      promise.then(() => "acquired"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]),
  ).resolves.toBe("pending");
}

function writeTask(taskId: string): TaskNode {
  return {
    type: "task",
    nodeId: taskId,
    taskId,
    workspace: "exclusive",
    input: {},
    dependsOn: [],
  };
}

function writeTaskDefinition(taskId: string): TaskDefinition {
  return {
    id: taskId,
    workspace: "exclusive",
    input: schema,
    output: schema,
    goal: () => taskId,
  };
}

function localWriteTask(taskId: string): TaskNode {
  return { ...writeTask(taskId), execution: "local" };
}

function localWriteTaskDefinition(taskId: string): TaskDefinition {
  return {
    id: taskId,
    workspace: "exclusive",
    input: schema,
    output: schema,
    execute: async () => ({}),
  };
}

function readTask(taskId: string): TaskNode {
  return {
    type: "task",
    nodeId: taskId,
    taskId,
    workspace: "shared",
    input: {},
    dependsOn: [],
  };
}

function readTaskDefinition(taskId: string): TaskDefinition {
  return {
    id: taskId,
    workspace: "shared",
    input: schema,
    output: schema,
    goal: () => taskId,
  };
}

describe("workspace admission", () => {
  it("uses the run workspace resource when a task has no explicit resource", async () => {
    let executed = false;
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([
        [
          "test",
          {
            execute: async () => {
              executed = true;
              return {};
            },
          },
        ],
      ]),
      taskDefinitions: new Map([["write", writeTaskDefinition("write")]]),
    });

    await executeTaskNode(
      context,
      writeTask("write"),
      new AbortController().signal,
      {
        invocationId: "write",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "write" },
      },
    );

    expect(executed).toBe(true);
  });

  it("admits concurrent reads from separate sessions to one workspace", async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const finishReads = deferred<void>();
    const executor = {
      execute: async ({ invocationId }: ExecutorRequest) => {
        if (invocationId === "first") firstStarted.resolve();
        else secondStarted.resolve();
        await finishReads.promise;
        return { invocationId };
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver: {
        resolve: async () => ({ key: Symbol("session"), executor }),
      },
      taskDefinitions: new Map([
        ["first", readTaskDefinition("first")],
        ["second", readTaskDefinition("second")],
      ]),
      workspaceResources: new Map([
        ["first", workspace],
        ["second", workspace],
      ]),
    });
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      "first",
      "first",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      "second",
      "second",
    );

    const first = executeTaskNode(
      context,
      readTask("first"),
      new AbortController().signal,
      {
        invocationId: "first",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "first" },
      },
    );
    await firstStarted.promise;
    const second = executeTaskNode(
      context,
      readTask("second"),
      new AbortController().signal,
      {
        invocationId: "second",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "second" },
      },
    );
    await secondStarted.promise;

    const waitingWriter = context.workspaceLocks.acquire(
      workspace,
      "exclusive",
    );
    await expectPending(waitingWriter);

    finishReads.resolve();
    await first;
    await second;
    (await waitingWriter).release();
  });

  it("holds one workspace writer before admitting another writer", async () => {
    const activeInvocations: string[] = [];
    const firstStarted = deferred<void>();
    const finishFirst = deferred<void>();
    let resolvedSessions = 0;
    const executor = {
      execute: async ({ invocationId }: ExecutorRequest) => {
        if (invocationId === "first") {
          firstStarted.resolve();
          await finishFirst.promise;
        }
        return { invocationId };
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver: {
        resolve: async () => {
          resolvedSessions += 1;
          return { key: Symbol("session"), executor };
        },
      },
      taskDefinitions: new Map([
        ["first", writeTaskDefinition("first")],
        ["second", writeTaskDefinition("second")],
      ]),
      workspaceResources: new Map([
        ["first", workspace],
        ["second", workspace],
      ]),
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
      context.sessionResolver,
      context.taskDefinitions,
      "first",
      "first",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      "second",
      "second",
    );
    const abortSignal = new AbortController().signal;

    const first = executeTaskNode(context, writeTask("first"), abortSignal, {
      invocationId: "first",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "first" },
    });
    await firstStarted.promise;

    const second = executeTaskNode(context, writeTask("second"), abortSignal, {
      invocationId: "second",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "second" },
    });

    await expectPending(second);
    expect(resolvedSessions).toBe(2);
    expect(activeInvocations).toEqual(["first"]);

    finishFirst.resolve();
    await first;
    await second;

    expect(activeInvocations).toEqual(["first", "second"]);
  });

  it("keeps a reader from a separate session waiting behind a writer", async () => {
    const writerStarted = deferred<void>();
    const readerStarted = deferred<void>();
    const finishWriter = deferred<void>();
    const executor = {
      execute: async ({ invocationId }: ExecutorRequest) => {
        if (invocationId === "writer") {
          writerStarted.resolve();
          await finishWriter.promise;
        } else {
          readerStarted.resolve();
        }
        return { invocationId };
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver: {
        resolve: async () => ({ key: Symbol("session"), executor }),
      },
      taskDefinitions: new Map([
        ["writer", writeTaskDefinition("writer")],
        ["reader", readTaskDefinition("reader")],
      ]),
      workspaceResources: new Map([
        ["writer", workspace],
        ["reader", workspace],
      ]),
    });
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      "writer",
      "writer",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      "reader",
      "reader",
    );
    const signal = new AbortController().signal;

    const writer = executeTaskNode(context, writeTask("writer"), signal, {
      invocationId: "writer",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "writer" },
    });
    await writerStarted.promise;
    const reader = executeTaskNode(context, readTask("reader"), signal, {
      invocationId: "reader",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "reader" },
    });

    await expectPending(readerStarted.promise);

    finishWriter.resolve();
    await writer;
    await readerStarted.promise;
    await reader;
  });

  it("prevents a reader from observing a writer's partial workspace mutation", async () => {
    const writerStarted = deferred<void>();
    const finishWriter = deferred<void>();
    let workspaceValue = "initial";
    let readerValue: string | undefined;
    const executor = {
      execute: async ({ invocationId }: ExecutorRequest) => {
        if (invocationId === "writer") {
          workspaceValue = "partial";
          writerStarted.resolve();
          await finishWriter.promise;
          workspaceValue = "complete";
        } else {
          readerValue = workspaceValue;
        }
        return { invocationId };
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver: {
        resolve: async () => ({ key: Symbol("session"), executor }),
      },
      taskDefinitions: new Map([
        ["writer", writeTaskDefinition("writer")],
        ["reader", readTaskDefinition("reader")],
      ]),
      workspaceResources: new Map([
        ["writer", workspace],
        ["reader", workspace],
      ]),
    });
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      "writer",
      "writer",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      context.sessionResolver,
      context.taskDefinitions,
      "reader",
      "reader",
    );
    const signal = new AbortController().signal;
    const writer = executeTaskNode(context, writeTask("writer"), signal, {
      invocationId: "writer",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "writer" },
    });

    await writerStarted.promise;
    const reader = executeTaskNode(context, readTask("reader"), signal, {
      invocationId: "reader",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "reader" },
    });
    await expectPending(reader);
    expect(workspaceValue).toBe("partial");
    expect(readerValue).toBeUndefined();

    finishWriter.resolve();
    await writer;
    await reader;
    expect(readerValue).toBe("complete");
  });

  it("retains a failed writer's lease until its child session terminates", async () => {
    const childTerminated = deferred<void>();
    const writerFailed = deferred<void>();
    const nextWriterStarted = deferred<void>();
    const executorFailure = new Error("writer failed");
    const executor = {
      execute: async (request: ExecutorRequest) => {
        if (request.taskId === "failing-writer") {
          request.onChildSession?.({
            termination: childTerminated.promise,
          });
          writerFailed.resolve();
          throw executorFailure;
        }
        nextWriterStarted.resolve();
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([
        ["failing-writer", writeTaskDefinition("failing-writer")],
        ["next-writer", writeTaskDefinition("next-writer")],
      ]),
      workspaceResources: new Map([
        ["failing-writer", workspace],
        ["next-writer", workspace],
      ]),
    });
    const firstWriter = executeTaskNode(
      context,
      writeTask("failing-writer"),
      new AbortController().signal,
      {
        invocationId: "failing-writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "failing-writer" },
      },
    );

    await writerFailed.promise;
    const nextWriter = executeTaskNode(
      context,
      writeTask("next-writer"),
      new AbortController().signal,
      {
        invocationId: "next-writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "next-writer" },
      },
    );
    await expectPending(nextWriter);

    childTerminated.resolve();
    try {
      await firstWriter;
      throw new Error("Expected writer failure");
    } catch (cause) {
      if (!(cause instanceof ExecutorError)) throw cause;
      expect(cause.cause).toBe(executorFailure);
    }
    await nextWriterStarted.promise;
    await nextWriter;
  });

  it("retains a workspace lease and quarantines the session after an unconfirmed executor disconnect", async () => {
    const executorFailure = new Error("executor disconnected");
    const executor = {
      execute: async (request: ExecutorRequest) => {
        request.onUncertainActivity?.({ reason: "disconnect" });
        throw executorFailure;
      },
    };
    const session = { key: Symbol("session"), executor };
    const sessionResolver = { resolve: async () => session };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver,
      taskDefinitions: new Map([["writer", writeTaskDefinition("writer")]]),
      workspaceResources: new Map([["writer", workspace]]),
    });
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      context.taskDefinitions,
      "writer",
      "writer",
    );

    await expect(
      executeTaskNode(
        context,
        writeTask("writer"),
        new AbortController().signal,
        {
          invocationId: "writer",
          results: context.results,
          remainingConsumers: context.remainingConsumers,
          subject: { type: "task", taskId: "writer" },
        },
      ),
    ).rejects.toMatchObject({ cause: executorFailure });

    await expectPending(context.workspaceLocks.acquire(workspace, "exclusive"));
    await expect(context.sessionLocks.acquire(session)).rejects.toMatchObject({
      name: "QuarantinedSessionError",
      cause: expect.any(UnconfirmedInvocationTerminationError),
    });
  });

  it("fails an executor response when termination remains unconfirmed", async () => {
    const executor = {
      execute: async (request: ExecutorRequest) => {
        request.onUncertainActivity?.({ reason: "timeout" });
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([["writer", writeTaskDefinition("writer")]]),
      workspaceResources: new Map([["writer", workspace]]),
    });

    await expect(
      executeTaskNode(
        context,
        writeTask("writer"),
        new AbortController().signal,
        {
          invocationId: "writer",
          results: context.results,
          remainingConsumers: context.remainingConsumers,
          subject: { type: "task", taskId: "writer" },
        },
      ),
    ).rejects.toMatchObject({
      cause: expect.any(UnconfirmedInvocationTerminationError),
    });
    expect(context.results.has("writer")).toBe(false);
  });

  it("releases write admission after uncertain execution termination is confirmed", async () => {
    const termination = deferred<void>();
    const nextWriterStarted = deferred<void>();
    const executor = {
      execute: async (request: ExecutorRequest) => {
        if (request.invocationId === "writer") {
          request.onUncertainActivity?.({
            reason: "timeout",
            termination: termination.promise,
          });
        } else {
          nextWriterStarted.resolve();
        }
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([
        ["writer", writeTaskDefinition("writer")],
        ["next-writer", writeTaskDefinition("next-writer")],
      ]),
      workspaceResources: new Map([
        ["writer", workspace],
        ["next-writer", workspace],
      ]),
    });
    const signal = new AbortController().signal;
    const writer = executeTaskNode(context, writeTask("writer"), signal, {
      invocationId: "writer",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "writer" },
    });

    await expectPending(writer);
    const nextWriter = executeTaskNode(
      context,
      writeTask("next-writer"),
      signal,
      {
        invocationId: "next-writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "next-writer" },
      },
    );
    await expectPending(nextWriterStarted.promise);

    termination.resolve();
    await writer;
    await nextWriterStarted.promise;
    await nextWriter;
  });

  it("exposes a failed writer's final workspace state after cleanup", async () => {
    const childTerminated = deferred<void>();
    const writerFailed = deferred<void>();
    let workspaceValue = "initial";
    let readerValue: string | undefined;
    const executor = {
      execute: async (request: ExecutorRequest) => {
        if (request.taskId === "failing-writer") {
          workspaceValue = "changed";
          request.onChildSession?.({
            termination: childTerminated.promise,
          });
          writerFailed.resolve();
          throw new Error("writer failed");
        }
        readerValue = workspaceValue;
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([
        ["failing-writer", writeTaskDefinition("failing-writer")],
        ["reader", readTaskDefinition("reader")],
      ]),
      workspaceResources: new Map([
        ["failing-writer", workspace],
        ["reader", workspace],
      ]),
    });
    const writer = executeTaskNode(
      context,
      writeTask("failing-writer"),
      new AbortController().signal,
      {
        invocationId: "failing-writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "failing-writer" },
      },
    );

    await writerFailed.promise;
    const reader = executeTaskNode(
      context,
      readTask("reader"),
      new AbortController().signal,
      {
        invocationId: "reader",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "reader" },
      },
    );
    await expectPending(reader);
    expect(readerValue).toBeUndefined();

    childTerminated.resolve();
    await expect(writer).rejects.toBeInstanceOf(ExecutorError);
    await reader;
    expect(readerValue).toBe("changed");
  });

  it("acquires workspace admission before the first write executor request", async () => {
    const requestStarted = deferred<void>();
    let requests = 0;
    const executor = {
      execute: async () => {
        requests += 1;
        requestStarted.resolve();
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([["writer", writeTaskDefinition("writer")]]),
      workspaceResources: new Map([["writer", workspace]]),
    });
    const readerLease = await context.workspaceLocks.acquire(
      workspace,
      "shared",
    );

    const writer = executeTaskNode(
      context,
      writeTask("writer"),
      new AbortController().signal,
      {
        invocationId: "writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "writer" },
      },
    );

    await expectPending(requestStarted.promise);
    expect(requests).toBe(0);

    readerLease.release();
    await requestStarted.promise;
    await writer;
    expect(requests).toBe(1);
  });

  it("does not start a free session until workspace admission succeeds", async () => {
    const executorStarted = deferred<void>();
    const executor = {
      execute: async () => {
        executorStarted.resolve();
        return {};
      },
    };
    const sessionResolver = {
      resolve: async () => ({ key: Symbol("session"), executor }),
    };
    const activeInvocations: string[] = [];
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver,
      taskDefinitions: new Map([["writer", writeTaskDefinition("writer")]]),
      workspaceResources: new Map([["writer", workspace]]),
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
      context.taskDefinitions,
      "writer",
      "writer",
    );
    const readerLease = await context.workspaceLocks.acquire(
      workspace,
      "shared",
    );

    const writer = executeTaskNode(
      context,
      writeTask("writer"),
      new AbortController().signal,
      {
        invocationId: "writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "writer" },
      },
    );

    await expectPending(executorStarted.promise);
    expect(activeInvocations).toEqual([]);

    readerLease.release();
    await executorStarted.promise;
    await writer;
    expect(activeInvocations).toEqual(["writer"]);
  });

  it("reports admission waiting before a blocked workspace request becomes active", async () => {
    const executorStarted = deferred<void>();
    const events: {
      readonly type: string;
      readonly state?: string;
      readonly phase?: string;
      readonly waitingReason?: string;
      readonly workspace?: string;
      readonly blockingInvocationId?: string;
    }[] = [];
    const executor = {
      execute: async () => {
        executorStarted.resolve();
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([["writer", writeTaskDefinition("writer")]]),
      workspaceResources: new Map([["writer", workspace]]),
      events: { emit: (event) => events.push(event) },
    });
    const readerLease = await context.workspaceLocks.acquire(
      workspace,
      "shared",
      undefined,
      0,
      "reader",
    );
    const writer = executeTaskNode(
      context,
      writeTask("writer"),
      new AbortController().signal,
      {
        invocationId: "writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "writer" },
      },
    );
    await expectPending(executorStarted.promise);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "invocation.progress",
        state: "waiting",
        phase: "admission",
        waitingReason: "workspace_unavailable",
        workspace: "exclusive",
        blockingInvocationId: "reader",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "invocation.retrying" }),
    );
    readerLease.release();
    await writer;
  });

  it("cancels a local task blocked behind an exclusive workspace holder", async () => {
    const executor = { execute: async () => ({ unexpected: true }) };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([["local", localWriteTaskDefinition("local")]]),
      workspaceResources: new Map([["local", workspace]]),
    });
    const holder = await context.workspaceLocks.acquire(
      workspace,
      "exclusive",
      undefined,
      0,
      "holder",
    );
    const controller = new AbortController();
    const cancelled = executeTaskNode(
      context,
      localWriteTask("local"),
      controller.signal,
      {
        invocationId: "cancelled",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "local" },
      },
    );

    await expectPending(cancelled);
    const reason = new Error("cancelled while waiting for workspace");
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);

    const replacement = executeTaskNode(
      context,
      localWriteTask("local"),
      new AbortController().signal,
      {
        invocationId: "replacement",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "local" },
      },
    );
    holder.release();
    await replacement;
  });

  it("leaves a shared session available while waiting for workspace admission", async () => {
    const writerStarted = deferred<void>();
    const independentStarted = deferred<void>();
    const executor = {
      execute: async ({ invocationId }: ExecutorRequest) => {
        if (invocationId === "writer") writerStarted.resolve();
        else independentStarted.resolve();
        return {};
      },
    };
    const session = { key: Symbol("session"), executor };
    const sessionResolver = { resolve: async () => session };
    const independentWorkspace: WorkspaceResource = { key: "/other-checkout" };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      sessionResolver,
      taskDefinitions: new Map([
        ["writer", writeTaskDefinition("writer")],
        ["independent", writeTaskDefinition("independent")],
      ]),
      workspaceResources: new Map([
        ["writer", workspace],
        ["independent", independentWorkspace],
      ]),
    });
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      context.taskDefinitions,
      "writer",
      "writer",
    );
    await resolveTaskSession(
      context.resolvedSessions,
      sessionResolver,
      context.taskDefinitions,
      "independent",
      "independent",
    );
    const readerLease = await context.workspaceLocks.acquire(
      workspace,
      "shared",
    );
    const signal = new AbortController().signal;

    const writer = executeTaskNode(context, writeTask("writer"), signal, {
      invocationId: "writer",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "writer" },
    });
    await expectPending(writerStarted.promise);

    const independent = executeTaskNode(
      context,
      writeTask("independent"),
      signal,
      {
        invocationId: "independent",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "independent" },
      },
    );
    await independentStarted.promise;
    await independent;

    readerLease.release();
    await writerStarted.promise;
    await writer;
  });

  it("retains write admission until a registered invocation effect terminates", async () => {
    const firstResponse = deferred<void>();
    const effectTerminated = deferred<void>();
    const secondStarted = deferred<void>();
    const executor = {
      execute: async (request: ExecutorRequest) => {
        if (request.invocationId === "first") {
          request.onBackgroundProcess?.({
            mutatesWorkspace: true,
            termination: effectTerminated.promise,
          });
          firstResponse.resolve();
        } else {
          secondStarted.resolve();
        }
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([
        ["first", writeTaskDefinition("first")],
        ["second", writeTaskDefinition("second")],
      ]),
      workspaceResources: new Map([
        ["first", workspace],
        ["second", workspace],
      ]),
    });
    const signal = new AbortController().signal;

    const first = executeTaskNode(context, writeTask("first"), signal, {
      invocationId: "first",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "first" },
    });
    await firstResponse.promise;

    const second = executeTaskNode(context, writeTask("second"), signal, {
      invocationId: "second",
      results: context.results,
      remainingConsumers: context.remainingConsumers,
      subject: { type: "task", taskId: "second" },
    });

    await expectPending(secondStarted.promise);

    effectTerminated.resolve();
    await first;
    await secondStarted.promise;
    await second;
  });

  it("rejects a mutating background process without a termination signal", async () => {
    let executorCompleted = false;
    const executor = {
      execute: async (request: ExecutorRequest) => {
        request.onBackgroundProcess?.({ mutatesWorkspace: true });
        executorCompleted = true;
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([["writer", writeTaskDefinition("writer")]]),
      workspaceResources: new Map([["writer", workspace]]),
    });

    await expect(
      executeTaskNode(
        context,
        writeTask("writer"),
        new AbortController().signal,
        {
          invocationId: "writer",
          results: context.results,
          remainingConsumers: context.remainingConsumers,
          subject: { type: "task", taskId: "writer" },
        },
      ),
    ).rejects.toBeInstanceOf(ExecutorError);
    expect(executorCompleted).toBe(false);
  });

  it("records a child session under its parent invocation until it terminates", async () => {
    const childTerminated = deferred<void>();
    const responseCompleted = deferred<void>();
    const executor = {
      execute: async (request: ExecutorRequest) => {
        request.onChildSession?.({
          termination: childTerminated.promise,
        });
        responseCompleted.resolve();
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([["writer", writeTaskDefinition("writer")]]),
      workspaceResources: new Map([["writer", workspace]]),
    });
    const parent = executeTaskNode(
      context,
      writeTask("writer"),
      new AbortController().signal,
      {
        invocationId: "writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "writer" },
      },
    );

    await responseCompleted.promise;
    expect(context.childSessions.parentInvocationIds()).toEqual(["writer"]);
    await expectPending(parent);

    childTerminated.resolve();
    await parent;
    expect(context.childSessions.parentInvocationIds()).toEqual([]);
  });

  it("retains a parent write lease while its child session remains active", async () => {
    const childTerminated = deferred<void>();
    const parentResponseCompleted = deferred<void>();
    const readerStarted = deferred<void>();
    const executor = {
      execute: async (request: ExecutorRequest) => {
        if (request.taskId === "writer") {
          request.onChildSession?.({
            termination: childTerminated.promise,
          });
          parentResponseCompleted.resolve();
        } else {
          readerStarted.resolve();
        }
        return {};
      },
    };
    const context = createExecutionContext({
      workId: "work",
      runId: "run",
      createInvocationId: (nodeId) => nodeId,
      workflowInput: undefined,
      executors: new Map([["test", executor]]),
      taskDefinitions: new Map([
        ["writer", writeTaskDefinition("writer")],
        ["reader", readTaskDefinition("reader")],
      ]),
      workspaceResources: new Map([
        ["writer", workspace],
        ["reader", workspace],
      ]),
    });
    const parent = executeTaskNode(
      context,
      writeTask("writer"),
      new AbortController().signal,
      {
        invocationId: "writer",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "writer" },
      },
    );

    await parentResponseCompleted.promise;
    const reader = executeTaskNode(
      context,
      readTask("reader"),
      new AbortController().signal,
      {
        invocationId: "reader",
        results: context.results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: "reader" },
      },
    );
    await expectPending(reader);

    childTerminated.resolve();
    await parent;
    await readerStarted.promise;
    await reader;
  });
});
