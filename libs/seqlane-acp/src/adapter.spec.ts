// @test-scope ./adapter.ts
// @test-scope ./contracts.ts
// @test-scope ./errors.ts
// @test-scope ./output.ts
// @test-scope ./prompt.ts
// @test-scope ./stream.ts
// @test-scope ./task.ts

import type { AcpAgentOptions } from "@mastra/acp";
import type { TaskDefinition, TaskDefinitionRegistry } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAcpExecutor } from "./adapter.js";
import { parseAcpLaunchConfiguration } from "./contracts.js";
import { AcpAdapterError, AcpMalformedStreamError } from "./errors.js";

const outputSchema = z.object({ value: z.string() });

function task(): TaskDefinition {
  return {
    id: "agent-task",
    input: z.string(),
    output: outputSchema,
    goal: (input) => `Complete ${input}`,
    instructions: ["Keep the change small"],
    references: ["AGENTS.md"],
  };
}

function configuration(
  overrides: Partial<ReturnType<typeof parseAcpLaunchConfiguration>> = {},
) {
  return parseAcpLaunchConfiguration({
    id: "test-agent",
    description: "A controlled ACP test agent",
    command: "test-agent",
    args: ["--stdio"],
    persistSession: false,
    ...overrides,
  });
}

function stream(text: string, chunks: readonly unknown[] = []) {
  return {
    fullStream: new ReadableStream<unknown>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    text: Promise.resolve(text),
  };
}

type TestAgent = {
  stream(
    messages: unknown,
    options: { readonly abortSignal?: AbortSignal; readonly runId?: string },
  ): Promise<ReturnType<typeof stream>>;
};

function request(
  overrides: Partial<
    Parameters<ReturnType<typeof createAcpExecutor>["execute"]>[0]
  > = {},
) {
  return {
    invocationId: "invocation-1",
    taskId: "agent-task",
    input: "the input",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function createTestExecutor(
  outputs: string[],
  options: {
    readonly chunks?: readonly unknown[];
    readonly createAgent?: (options: AcpAgentOptions) => TestAgent;
  } = {},
) {
  const tasks: TaskDefinitionRegistry = new Map([["agent-task", task()]]);
  return createAcpExecutor(tasks, configuration(), {
    structuredOutputRetryCount: 1,
    createAgent:
      options.createAgent ??
      (() => ({
        stream: async () => {
          const output = outputs.shift();
          if (output === undefined)
            throw new Error("test ACP output exhausted");
          return stream(output, options.chunks);
        },
      })),
  });
}

describe("private ACP adapter", () => {
  it("maps streamed output and tool activity through Seqlane contracts", async () => {
    const activities: unknown[] = [];
    const metrics: unknown[] = [];
    const executor = createTestExecutor(['{"value":"done"}'], {
      chunks: [
        {
          type: "tool-call-delta",
          payload: {
            toolCallId: "call-1",
            toolName: "read_file",
            argsTextDelta: "AGENTS.md",
          },
        },
        {
          type: "tool-result",
          payload: {
            toolCallId: "call-1",
            toolName: "read_file",
            result: "ok",
          },
        },
      ],
    });

    await expect(
      executor.execute(
        request({
          onActivity: (activity) => activities.push(activity),
          onMetrics: (metric) => metrics.push(metric),
        }),
      ),
    ).resolves.toEqual({ value: "done" });
    expect(activities).toEqual([
      {
        activityId: "call-1",
        kind: "tool",
        name: "read_file",
        state: "started",
        input: "AGENTS.md",
      },
      {
        activityId: "call-1",
        kind: "tool",
        name: "read_file",
        state: "succeeded",
        output: "ok",
      },
    ]);
    expect(metrics[0]).toMatchObject({ durationMs: expect.any(Number) });
  });

  it("passes cancellation to the ACP stream and normalizes the failure", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor = createTestExecutor([], {
      createAgent: () => ({
        stream: async (_messages, options) => {
          receivedSignal = options.abortSignal;
          started();
          const aborted = new Promise<never>((_resolve, reject) => {
            options.abortSignal?.addEventListener(
              "abort",
              () => reject(options.abortSignal?.reason ?? new Error("aborted")),
              { once: true },
            );
          });
          return {
            fullStream: new ReadableStream<unknown>(),
            text: aborted,
          };
        },
      }),
    });
    const execution = executor.execute(request({ signal: controller.signal }));
    await startedPromise;
    controller.abort(new Error("cancelled by caller"));

    await expect(execution).rejects.toMatchObject({
      code: "cancellation",
    });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("rejects unresolved permission requests without selecting an option", async () => {
    type PermissionRequest = Parameters<
      NonNullable<AcpAgentOptions["onPermissionRequest"]>
    >[0];
    let onPermissionRequest:
      NonNullable<AcpAgentOptions["onPermissionRequest"]> | undefined;
    const permissionRequest: PermissionRequest = {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Run command" },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    };
    const executor = createTestExecutor(['{"value":"done"}'], {
      createAgent: (options) => {
        onPermissionRequest = options.onPermissionRequest;
        return {
          stream: async () => {
            const callback = onPermissionRequest;
            if (callback === undefined) throw new Error("missing callback");
            await callback(permissionRequest);
            return stream('{"value":"done"}');
          },
        };
      },
    });

    await expect(executor.execute(request())).rejects.toMatchObject({
      name: "InteractionRequiredError",
    });
    await expect(onPermissionRequest?.(permissionRequest)).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("fails malformed stream data through the typed private boundary", async () => {
    const executor = createTestExecutor(['{"value":"done"}'], {
      chunks: [
        {
          type: "tool-result",
          payload: { toolCallId: "call-1" },
        },
      ],
    });

    await expect(executor.execute(request())).rejects.toBeInstanceOf(
      AcpMalformedStreamError,
    );
  });

  it("requires an explicit validated launch configuration", () => {
    expect(() =>
      parseAcpLaunchConfiguration({
        id: "test-agent",
        description: "A test agent",
        command: "test-agent",
      }),
    ).toThrow(AcpAdapterError);
    expect(() => parseAcpLaunchConfiguration(configuration())).not.toThrow();
  });
});
