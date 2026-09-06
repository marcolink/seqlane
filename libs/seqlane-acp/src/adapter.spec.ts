// @test-scope ./adapter.ts
// @test-scope ./contracts.ts
// @test-scope ./errors.ts
// @test-scope ./output.ts
// @test-scope ./prompt.ts
// @test-scope ./stream.ts
// @test-scope ./task.ts

import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import type { AgentTaskDefinition } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAcpAdapter } from "./adapter.js";
import {
  parseAcpLaunchConfiguration,
  type AcpAgentFactoryOptions,
} from "./contracts.js";
import { AcpAdapterError, AcpMalformedStreamError } from "./errors.js";
import {
  MAX_RESPONSE_TEXT_LENGTH,
  MAX_STRUCTURED_OUTPUT_LENGTH,
  parseStructuredOutput,
} from "./output.js";
import {
  MAX_ACTIVITY_COUNT,
  MAX_ACTIVITY_INPUT_LENGTH,
  MAX_TOOL_CALL_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
} from "./stream.js";

const outputSchema = z.object({ value: z.string() });

function task(): AgentTaskDefinition {
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

function request(overrides: Partial<AgentAdapterRequest> = {}) {
  return {
    invocationId: "invocation-1",
    task: task(),
    input: "the input",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function createTestExecutor(
  outputs: string[],
  options: {
    readonly chunks?: readonly unknown[];
    readonly createAgent?: (options: AcpAgentFactoryOptions) => TestAgent;
  } = {},
) {
  return createAcpAdapter(configuration(), {
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
          type: "tool-call-delta",
          payload: {
            toolCallId: "call-1",
            toolName: "read_file",
            argsTextDelta: "\nREADME.md",
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
        state: "progress",
        input: "\nREADME.md",
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

  it("maps failed tool activity and preserves generic ACP configuration", async () => {
    let agentOptions: AcpAgentFactoryOptions | undefined;
    const activities: unknown[] = [];
    const metrics: unknown[] = [];
    const executor = createAcpAdapter(
      configuration({
        id: "other-acp",
        description: "Another ACP implementation",
        command: "custom-acp",
        args: ["--stdio", "--profile", "safe"],
        env: { ACP_TOKEN: "secret" },
        cwd: "/workspace",
        persistSession: false,
        model: "vendor-model-id",
      }),
      {
        createAgent: (options) => {
          agentOptions = options;
          return {
            stream: async () =>
              stream('{"value":"done"}', [
                {
                  type: "tool-call-delta",
                  payload: {
                    toolCallId: "call-2",
                    toolName: "run_command",
                  },
                },
                {
                  type: "tool-result",
                  payload: {
                    toolCallId: "call-2",
                    toolName: "run_command",
                    result: "permission denied",
                    isError: true,
                  },
                },
              ]),
          };
        },
      },
    );

    await expect(
      executor.execute(
        request({
          onActivity: (activity) => activities.push(activity),
          onMetrics: (metric) => metrics.push(metric),
        }),
      ),
    ).resolves.toEqual({ value: "done" });
    expect(agentOptions).toMatchObject({
      id: "other-acp",
      description: "Another ACP implementation",
      command: "custom-acp",
      args: ["--stdio", "--profile", "safe"],
      env: { ACP_TOKEN: "secret" },
      cwd: "/workspace",
      persistSession: false,
      model: "vendor-model-id",
    });
    expect(activities).toEqual([
      {
        activityId: "call-2",
        kind: "tool",
        name: "run_command",
        state: "started",
      },
      {
        activityId: "call-2",
        kind: "tool",
        name: "run_command",
        state: "failed",
        output: "permission denied",
        message: "Tool failed",
      },
    ]);
    expect(metrics[0]).toMatchObject({ model: "vendor-model-id" });
    expect(metrics[0]).not.toHaveProperty("modelSelection");
    expect(executor.capabilities).toEqual({
      execute: true,
      modelSelection: false,
      structuredOutput: true,
      sessionReuse: false,
      checkpoint: false,
      fork: false,
      activity: true,
      sessionUi: false,
    });
  });

  it("rejects dynamic model selection before ACP execution or metrics", async () => {
    let streamCalls = 0;
    const metrics: unknown[] = [];
    const executor = createTestExecutor(['{"value":"done"}'], {
      createAgent: () => ({
        stream: async () => {
          streamCalls += 1;
          return stream('{"value":"done"}');
        },
      }),
    });

    await expect(
      executor.execute(
        request({
          modelSelection: {
            model: { provider: "openai", model: "gpt-5.2" },
            reasoning: "high",
          },
          onMetrics: (metric) => metrics.push(metric),
        }),
      ),
    ).rejects.toMatchObject({
      name: "AcpAdapterError",
      code: "configuration",
    });
    expect(streamCalls).toBe(0);
    expect(metrics).toEqual([]);
    expect(executor.capabilities.modelSelection).toBe(false);
  });

  it("repairs structured output and reports the normalized diagnostic", async () => {
    const diagnostics: unknown[] = [];
    const executor = createTestExecutor(["not json", '{"value":"repaired"}']);

    await expect(
      executor.execute(
        request({
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ),
    ).resolves.toEqual({ value: "repaired" });
    expect(diagnostics).toEqual([
      {
        code: "structured-output",
        message: "ACP structured output was repaired after attempt 1",
      },
    ]);
  });

  it("passes cancellation to the ACP stream and normalizes the failure", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let streamCancelled = false;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor = createTestExecutor([], {
      createAgent: () => ({
        stream: async (_messages, options) => {
          receivedSignal = options.abortSignal;
          started();
          return {
            fullStream: new ReadableStream<unknown>({
              cancel() {
                streamCancelled = true;
              },
            }),
            text: new Promise<string>(() => undefined),
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
    expect(streamCancelled).toBe(true);
  });

  it("bounds response text before structured-output parsing", async () => {
    const executor = createTestExecutor([
      "x".repeat(MAX_RESPONSE_TEXT_LENGTH + 1),
    ]);

    await expect(executor.execute(request())).rejects.toMatchObject({
      name: "AcpLimitError",
      code: "limit",
      resource: "response text",
    });
  });

  it("cancels the ACP stream when streamed response text exceeds its limit", async () => {
    let streamCancelled = false;
    const executor = createAcpAdapter(configuration(), {
      createAgent: () => ({
        stream: async () => ({
          fullStream: new ReadableStream<unknown>({
            start(controller) {
              controller.enqueue({
                type: "text-delta",
                payload: { text: "x".repeat(MAX_RESPONSE_TEXT_LENGTH + 1) },
              });
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          text: new Promise<string>(() => undefined),
        }),
      }),
    });

    await expect(executor.execute(request())).rejects.toMatchObject({
      name: "AcpLimitError",
      code: "limit",
      resource: "response text",
    });
    expect(streamCancelled).toBe(true);
  });

  it("bounds structured output before JSON parsing", () => {
    expect(() =>
      parseStructuredOutput("x".repeat(MAX_STRUCTURED_OUTPUT_LENGTH + 1)),
    ).toThrowError(
      expect.objectContaining({
        name: "AcpLimitError",
        code: "limit",
        resource: "structured output",
      }),
    );
  });

  it.each([
    ["tool call ids", "toolCallId", MAX_TOOL_CALL_ID_LENGTH],
    ["tool names", "toolName", MAX_TOOL_NAME_LENGTH],
  ] as const)(
    "bounds %s in stream activity",
    async (_label, field, maximum) => {
      const payload = {
        toolCallId: "call-1",
        toolName: "tool",
        [field]: "x".repeat(maximum + 1),
      };
      const executor = createTestExecutor(['{"value":"done"}'], {
        chunks: [{ type: "tool-call-delta", payload }],
      });

      await expect(executor.execute(request())).rejects.toMatchObject({
        name: "AcpLimitError",
        code: "limit",
        resource: field === "toolCallId" ? "tool call id" : "tool name",
        maximum,
      });
    },
  );

  it("bounds the number of accumulated activities", async () => {
    const chunks = Array.from(
      { length: MAX_ACTIVITY_COUNT + 1 },
      (_, index) => ({
        type: "tool-call-delta",
        payload: {
          toolCallId: `call-${index}`,
          toolName: "tool",
        },
      }),
    );
    const executor = createTestExecutor(['{"value":"done"}'], { chunks });

    await expect(executor.execute(request())).rejects.toMatchObject({
      name: "AcpLimitError",
      code: "limit",
      resource: "activity count",
      maximum: MAX_ACTIVITY_COUNT,
    });
  });

  it("bounds accumulated activity input", async () => {
    const executor = createTestExecutor(['{"value":"done"}'], {
      chunks: [
        {
          type: "tool-call-delta",
          payload: {
            toolCallId: "call-1",
            toolName: "tool",
            argsTextDelta: "x".repeat(MAX_ACTIVITY_INPUT_LENGTH + 1),
          },
        },
      ],
    });

    await expect(executor.execute(request())).rejects.toMatchObject({
      name: "AcpLimitError",
      code: "limit",
      resource: "activity input",
      maximum: MAX_ACTIVITY_INPUT_LENGTH,
    });
  });

  it("rejects unresolved permission requests without selecting an option", async () => {
    type PermissionRequest = Parameters<
      NonNullable<AcpAgentFactoryOptions["onPermissionRequest"]>
    >[0];
    let onPermissionRequest:
      NonNullable<AcpAgentFactoryOptions["onPermissionRequest"]> | undefined;
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
