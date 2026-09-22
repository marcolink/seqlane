// @test-scope ./runtime-profile.ts
// @test-scope ../../runtime/execution/abortable.ts
// @test-scope ../../runtime/session/session-lock.ts
import type { AgentAdapter, AgentRuntimeFactory } from "@seqlane/agent-adapter";
import type { TaskDefinition, TaskDefinitionRegistry } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  executeAgentAdapterRequest,
  RuntimeAdapterExecutionStartError,
  resolveRuntimeProfile,
} from "./runtime-profile.js";
import type { ExecutorRequest } from "../../runtime/execution/executor.js";
import { SessionLockRegistry } from "../../runtime/session/session-lock.js";

const capabilities = {
  execute: true as const,
  modelSelection: false,
  structuredOutput: true,
  sessionReuse: true,
  checkpoint: true,
  fork: true,
  activity: false,
  sessionUi: false,
};

function task(): TaskDefinition {
  return {
    id: "fixture.task",
    input: z.unknown(),
    output: z.unknown(),
    execute: async ({ context }) => context.runAgent({ goal: "complete task" }),
  };
}

function request(taskId: string): ExecutorRequest {
  return {
    invocationId: "fixture:1",
    observability: {},
    taskId,
    executor: "agent",
    input: null,
    signal: new AbortController().signal,
  };
}

describe("runtime profile agent runtime boundary", () => {
  it("requires an injected runtime for an agent profile", async () => {
    const definition = task();

    await expect(
      resolveRuntimeProfile(
        { id: "custom", workspace: process.cwd() },
        new Map([[definition.id, definition]]),
        new AbortController().signal,
        null,
      ),
    ).rejects.toThrow('Runtime profile "custom" requires an agent runtime');
  });

  it("validates the workspace before instantiating an agent runtime", async () => {
    const definition = task();
    let created = 0;
    let closed = 0;

    await expect(
      resolveRuntimeProfile(
        {
          id: "custom",
          workspace: "/seqlane-workspace-that-does-not-exist",
        },
        new Map([[definition.id, definition]]),
        new AbortController().signal,
        null,
        undefined,
        {
          agentRuntime: async () => {
            created += 1;
            return {
              identity: "fixture",
              capabilities,
              createAdapter: () => {
                throw new Error("Adapter must not be created");
              },
              redactAdapter: (adapter) => adapter,
              close: async () => {
                closed += 1;
              },
            };
          },
        },
      ),
    ).rejects.toThrow("Could not resolve workspace");

    expect(created).toBe(0);
    expect(closed).toBe(0);
  });

  it("uses only the injected runtime and releases its adapters", async () => {
    const definition = task();
    const definitions: TaskDefinitionRegistry = new Map([
      [definition.id, definition],
    ]);
    let adapterCreations = 0;
    let adaptersClosed = 0;
    let runtimeClosed = 0;
    const createAdapter = (): AgentAdapter => ({
      capabilities,
      execute: async (value) => {
        value.onExecutionStarted();
        return { value: "done" };
      },
      close: async () => {
        adaptersClosed += 1;
      },
      captureCheckpoint: async () => "checkpoint",
      fork: async () => createAdapter(),
    });
    const agentRuntime: AgentRuntimeFactory = async () => ({
      identity: "fixture",
      capabilities,
      createAdapter: () => {
        adapterCreations += 1;
        return createAdapter();
      },
      redactAdapter: (adapter) => adapter,
      close: async () => {
        runtimeClosed += 1;
      },
    });

    const execution = await resolveRuntimeProfile(
      { id: "custom", workspace: process.cwd() },
      definitions,
      new AbortController().signal,
      null,
      undefined,
      { agentRuntime, runId: "run-1" },
    );
    expect(adapterCreations).toBe(0);

    const session = await execution.sessionResolver.resolve({
      invocationId: "fixture:1",
      task: definition,
    });
    await session.executor.execute(request(definition.id));
    const checkpoint = await session.checkpoint?.();
    await session.fork?.({
      checkpoint,
      invocationId: "fixture:2",
      task: definition,
    });
    await execution.close?.();

    expect(adapterCreations).toBe(1);
    expect(adaptersClosed).toBe(2);
    expect(runtimeClosed).toBe(1);
  });

  it("rejects a one-shot adapter that changes declared capabilities", async () => {
    const definition = task();
    const execution = await resolveRuntimeProfile(
      { id: "custom", workspace: process.cwd() },
      new Map([[definition.id, definition]]),
      new AbortController().signal,
      null,
      undefined,
      {
        agentRuntime: async () => ({
          identity: "fixture",
          capabilities,
          createAdapter: () => ({
            capabilities: { ...capabilities, sessionReuse: false },
            execute: async () => ({ value: "done" }),
            captureCheckpoint: async () => "checkpoint",
            fork: async () => {
              throw new Error("not used");
            },
          }),
          redactAdapter: (adapter) => adapter,
        }),
      },
    );

    expect(() => execution.executors.agent(definition)).toThrow(
      'Agent runtime capability "sessionReuse" changed after setup',
    );
    await execution.close?.();
  });

  it("does not forward model selection to an adapter without that capability", async () => {
    const definition = task();
    const definitions = new Map([[definition.id, definition]]);
    let received: unknown;
    const adapter: AgentAdapter = {
      capabilities: { ...capabilities, modelSelection: false },
      execute: async (value) => {
        value.onExecutionStarted();
        received = value;
        return { value: "done" };
      },
      captureCheckpoint: async () => "checkpoint",
      fork: async () => adapter,
    };

    await executeAgentAdapterRequest(
      adapter,
      definitions,
      { model: { provider: "fixture", model: "model" } },
      request(definition.id),
    );

    expect(received).not.toHaveProperty("modelSelection");
  });

  it("preserves the task deadline when an adapter completes after abort", async () => {
    const definition = task();
    const definitions = new Map([[definition.id, definition]]);
    let completedAfterAbort = false;
    const adapter: AgentAdapter = {
      capabilities,
      execute: async (value) => {
        value.onExecutionStarted();
        return new Promise((resolve) => {
          value.signal.addEventListener(
            "abort",
            () => {
              completedAfterAbort = true;
              resolve({ value: "done" });
            },
            {
              once: true,
            },
          );
        });
      },
      captureCheckpoint: async () => "checkpoint",
      fork: async () => adapter,
    };

    await expect(
      executeAgentAdapterRequest(adapter, definitions, undefined, {
        ...request(definition.id),
        agent: { goal: "complete task", timeoutMs: 1 },
      }),
    ).rejects.toBeDefined();
    expect(completedAfterAbort).toBe(true);
  });

  it("keeps a timed-out session unavailable until adapter termination confirms", async () => {
    vi.useFakeTimers();
    try {
      const definition = task();
      const definitions = new Map([[definition.id, definition]]);
      let confirmTermination!: () => void;
      let terminationStarted = false;
      const adapter: AgentAdapter = {
        capabilities,
        execute: async (value) => {
          value.onExecutionStarted();
          return new Promise((_resolve, reject) => {
            value.signal.addEventListener(
              "abort",
              () => {
                terminationStarted = true;
                confirmTermination = () =>
                  reject(new Error("adapter termination confirmed"));
              },
              { once: true },
            );
          });
        },
        captureCheckpoint: async () => "checkpoint",
        fork: async () => adapter,
      };

      const execution = executeAgentAdapterRequest(
        adapter,
        definitions,
        undefined,
        {
          ...request(definition.id),
          agent: { goal: "complete task", timeoutMs: 1 },
        },
      );
      const outcome = execution.then(
        () => undefined,
        (error: unknown) => error,
      );
      const locks = new SessionLockRegistry();
      const session = {
        key: Symbol("timed-out-agent-session"),
        executor: { execute: async () => undefined },
      };
      const active = await locks.acquire(session);
      void outcome.finally(() => active.release());

      await vi.advanceTimersByTimeAsync(1);
      expect(terminationStarted).toBe(true);

      let reuseAdmitted = false;
      const reuse = locks.acquire(session).then((lease) => {
        reuseAdmitted = true;
        lease.release();
      });
      await Promise.resolve();
      expect(reuseAdmitted).toBe(false);

      confirmTermination();
      await expect(outcome).resolves.toMatchObject({ name: "TimeoutError" });
      await reuse;
      expect(reuseAdmitted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an adapter that completes without starting execution", async () => {
    const definition = task();
    const definitions = new Map([[definition.id, definition]]);
    const adapter: AgentAdapter = {
      capabilities,
      execute: async () => ({ value: "done" }),
      captureCheckpoint: async () => "checkpoint",
      fork: async () => adapter,
    };

    await expect(
      executeAgentAdapterRequest(
        adapter,
        definitions,
        undefined,
        request(definition.id),
      ),
    ).rejects.toBeInstanceOf(RuntimeAdapterExecutionStartError);
  });

  it("starts the deadline after adapter queueing", async () => {
    vi.useFakeTimers();
    try {
      const definition = task();
      const definitions = new Map([[definition.id, definition]]);
      let signal: AbortSignal | undefined;
      let startExecution: (() => void) | undefined;
      const adapter: AgentAdapter = {
        capabilities,
        execute: async (value) => {
          signal = value.signal;
          startExecution = value.onExecutionStarted;
          return new Promise((_resolve, reject) => {
            value.signal.addEventListener(
              "abort",
              () => reject(value.signal.reason),
              {
                once: true,
              },
            );
          });
        },
        captureCheckpoint: async () => "checkpoint",
        fork: async () => adapter,
      };

      const execution = executeAgentAdapterRequest(
        adapter,
        definitions,
        undefined,
        {
          ...request(definition.id),
          agent: { goal: "complete task", timeoutMs: 1 },
        },
      );
      const executionFailure = execution.then(
        () => undefined,
        (error: unknown) => error,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(signal?.aborted).toBe(false);

      startExecution?.();
      await vi.advanceTimersByTimeAsync(1);
      await expect(executionFailure).resolves.toMatchObject({
        name: "TimeoutError",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
