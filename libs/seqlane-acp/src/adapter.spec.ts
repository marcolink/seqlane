// @test-scope ./adapter.ts
// @test-scope ./contracts.ts
// @test-scope ./errors.ts
// @test-scope ./output.ts
// @test-scope ./prompt.ts
// @test-scope ./stream.ts
// @test-scope ./task.ts

import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import { SpanType } from "@mastra/core/observability";
import type { AgentTaskRequest, TaskDefinition } from "@seqlane/core";
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
  MAX_TOOL_RESULT_BYTES,
} from "./stream.js";

const outputSchema = z.object({ value: z.string() });

function task(): TaskDefinition {
  return {
    id: "agent-task",
    input: z.string(),
    output: outputSchema,
    execute: async () => ({ value: "done" }),
  };
}

const agent: AgentTaskRequest = {
  goal: "Complete the input",
  instructions: ["Keep the change small"],
  references: ["AGENTS.md"],
};

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
  disconnect?(): void;
  stream(
    messages: unknown,
    options: { readonly abortSignal?: AbortSignal; readonly runId?: string },
  ): Promise<ReturnType<typeof stream>>;
};

function firstMessageContent(messages: unknown): string {
  if (
    !Array.isArray(messages) ||
    messages[0] === undefined ||
    typeof messages[0] !== "object" ||
    messages[0] === null ||
    !("content" in messages[0]) ||
    typeof messages[0].content !== "string"
  ) {
    throw new Error("missing user prompt");
  }
  return messages[0].content;
}

function request(overrides: Partial<AgentAdapterRequest> = {}) {
  return {
    invocationId: "invocation-1",
    task: task(),
    input: "the input",
    agent,
    signal: new AbortController().signal,
    ...overrides,
    observability: overrides.observability ?? {},
  };
}

interface RecordedSpan {
  readonly id: string;
  readonly type: SpanType;
  readonly parent?: RecordedSpan;
  readonly options: Record<string, unknown>;
  readonly endCalls: unknown[];
  readonly errorCalls: unknown[];
}

function spanRecorder() {
  const spans: RecordedSpan[] = [];
  const closeOrder: string[] = [];
  const attach = (record: RecordedSpan): object => ({
    id: record.id,
    isValid: true,
    createChildSpan: (options: Record<string, unknown>) => {
      const child: RecordedSpan = {
        id: `${String(options.type)}-${spans.length}`,
        type: options.type as SpanType,
        parent: record,
        options,
        endCalls: [],
        errorCalls: [],
      };
      spans.push(child);
      return attach(child);
    },
    end: (options?: unknown) => {
      record.endCalls.push(options);
      closeOrder.push(record.id);
    },
    error: (options: unknown) => {
      record.errorCalls.push(options);
      closeOrder.push(record.id);
    },
    update: () => undefined,
  });
  const root: RecordedSpan = {
    id: "workflow-step",
    type: SpanType.WORKFLOW_STEP,
    options: {},
    endCalls: [],
    errorCalls: [],
  };
  return {
    spans,
    closeOrder,
    observability: {
      tracingContext: { currentSpan: attach(root) as never },
    },
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

  it("maps an ACP tool call before its direct tool result", async () => {
    const activities: unknown[] = [];
    const executor = createTestExecutor(['{"value":"done"}'], {
      chunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "call-1",
            toolName: "read_file",
            args: { path: "README.md" },
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
        request({ onActivity: (activity) => activities.push(activity) }),
      ),
    ).resolves.toEqual({ value: "done" });
    expect(activities).toEqual([
      {
        activityId: "call-1",
        kind: "tool",
        name: "read_file",
        state: "started",
        input: { path: "README.md" },
      },
      {
        activityId: "call-1",
        kind: "tool",
        name: "read_file",
        state: "succeeded",
        output: "ok",
      },
    ]);
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
    const recorder = spanRecorder();
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
          observability: recorder.observability,
        }),
      ),
    ).rejects.toMatchObject({
      name: "AcpAdapterError",
      code: "configuration",
    });
    expect(streamCalls).toBe(0);
    expect(metrics).toEqual([]);
    expect(executor.capabilities.modelSelection).toBe(false);
    const runs = recorder.spans.filter(
      (span) => span.type === SpanType.AGENT_RUN,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.errorCalls).toHaveLength(1);
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

  it("preserves the task prompt and schema in structured-output repairs", async () => {
    const prompts: string[] = [];
    const outputs = ["not json", '{"value":"repaired"}'];
    const executor = createAcpAdapter(configuration(), {
      structuredOutputRetryCount: 1,
      createAgent: () => ({
        stream: async (messages) => {
          prompts.push(firstMessageContent(messages));
          const output = outputs.shift();
          if (output === undefined) throw new Error("test output exhausted");
          return stream(output);
        },
      }),
    });

    await expect(executor.execute(request())).resolves.toEqual({
      value: "repaired",
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Complete the input");
    expect(prompts[1]).toContain(JSON.stringify(z.toJSONSchema(outputSchema)));
    expect(prompts[1]).toContain("Validation errors:");
  });

  it("keeps one native run across repair attempts while callbacks remain separate outputs", async () => {
    const recorder = spanRecorder();
    const activities: unknown[] = [];
    const metrics: unknown[] = [];
    const diagnostics: unknown[] = [];
    const responses = [
      {
        text: "not json",
        chunks: [
          {
            type: "tool-call-delta",
            payload: { toolCallId: "repair-0", toolName: "read_file" },
          },
          {
            type: "tool-result",
            payload: { toolCallId: "repair-0", toolName: "read_file" },
          },
        ],
      },
      {
        text: '{"value":"repaired"}',
        chunks: [
          {
            type: "tool-call-delta",
            payload: { toolCallId: "repair-1", toolName: "write_file" },
          },
          {
            type: "tool-result",
            payload: { toolCallId: "repair-1", toolName: "write_file" },
          },
        ],
      },
    ];
    const executor = createAcpAdapter(
      configuration({ model: "requested-model" }),
      {
        structuredOutputRetryCount: 1,
        createAgent: () => ({
          stream: async () => {
            const response = responses.shift();
            if (response === undefined) throw new Error("responses exhausted");
            return stream(response.text, response.chunks);
          },
        }),
      },
    );

    await expect(
      executor.execute(
        request({
          observability: recorder.observability,
          onActivity: (activity) => activities.push(activity),
          onMetrics: (metric) => metrics.push(metric),
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ),
    ).resolves.toEqual({ value: "repaired" });

    const runs = recorder.spans.filter(
      (span) => span.type === SpanType.AGENT_RUN,
    );
    const tools = recorder.spans.filter(
      (span) => span.type === SpanType.TOOL_CALL,
    );
    expect(runs).toHaveLength(1);
    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.options.metadata)).toEqual([
      { "seqlane.attemptIndex": 0 },
      { "seqlane.attemptIndex": 1 },
    ]);
    expect(
      recorder.spans.some((span) => span.type === SpanType.MODEL_GENERATION),
    ).toBe(false);
    expect(JSON.stringify(recorder.spans)).not.toContain("requested-model");
    expect(activities).toHaveLength(4);
    expect(metrics).toHaveLength(2);
    expect(metrics).toEqual([
      expect.objectContaining({ model: "requested-model" }),
      expect.objectContaining({ model: "requested-model" }),
    ]);
    expect(diagnostics).toEqual([
      {
        code: "structured-output",
        message: "ACP structured output was repaired after attempt 1",
      },
    ]);
    expect(recorder.closeOrder).toEqual([
      tools[0]?.id,
      tools[1]?.id,
      runs[0]?.id,
    ]);
  });

  it("passes cancellation to the ACP stream and normalizes the failure", async () => {
    const controller = new AbortController();
    const recorder = spanRecorder();
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
              start(streamController) {
                streamController.enqueue({
                  type: "tool-call-delta",
                  payload: { toolCallId: "active-tool", toolName: "read_file" },
                });
              },
              cancel() {
                streamCancelled = true;
              },
            }),
            text: new Promise<string>(() => undefined),
          };
        },
      }),
    });
    const execution = executor.execute(
      request({
        signal: controller.signal,
        observability: recorder.observability,
      }),
    );
    await startedPromise;
    controller.abort(new Error("cancelled by caller"));

    await expect(execution).rejects.toMatchObject({
      code: "cancellation",
    });
    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(streamCancelled).toBe(true);
    const agent = recorder.spans.find(
      (span) => span.type === SpanType.AGENT_RUN,
    );
    const tool = recorder.spans.find(
      (span) => span.type === SpanType.TOOL_CALL,
    );
    expect(recorder.closeOrder).toEqual([tool?.id, agent?.id]);
    expect(tool?.errorCalls).toHaveLength(1);
    expect(tool?.errorCalls[0]).toMatchObject({
      endSpan: true,
      attributes: { success: false },
      metadata: { "seqlane.acp.outcome": "cancelled" },
    });
    expect((tool?.errorCalls[0] as { error: Error }).error.message).toBe(
      "ACP v1 tool call cancelled",
    );
    expect(agent?.errorCalls).toHaveLength(1);
    expect(agent?.errorCalls[0]).toMatchObject({
      endSpan: true,
      metadata: { "seqlane.acp.outcome": "cancelled" },
    });
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
    let promptCancelled = false;
    let receivedSignal: AbortSignal | undefined;
    const executor = createAcpAdapter(configuration(), {
      createAgent: () => ({
        stream: async (_messages, options) => {
          receivedSignal = options.abortSignal;
          receivedSignal?.addEventListener("abort", () => {
            promptCancelled = true;
          });
          return {
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
          };
        },
      }),
    });

    await expect(executor.execute(request())).rejects.toMatchObject({
      name: "AcpLimitError",
      code: "limit",
      resource: "response text",
    });
    expect(streamCancelled).toBe(true);
    expect(promptCancelled).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("accepts a tool result at the serialized byte boundary", async () => {
    const result = "x".repeat(MAX_TOOL_RESULT_BYTES - 2);
    const executor = createTestExecutor(['{"value":"done"}'], {
      chunks: [
        {
          type: "tool-call-delta",
          payload: { toolCallId: "call-1", toolName: "tool" },
        },
        {
          type: "tool-result",
          payload: {
            toolCallId: "call-1",
            toolName: "tool",
            result,
          },
        },
      ],
    });

    await expect(executor.execute(request())).resolves.toEqual({
      value: "done",
    });
  });

  it("cancels the ACP stream and returns a typed error for an oversized tool result", async () => {
    let streamCancelled = false;
    const result = "x".repeat(MAX_TOOL_RESULT_BYTES - 1);
    const executor = createAcpAdapter(configuration(), {
      createAgent: () => ({
        stream: async () => ({
          fullStream: new ReadableStream<unknown>({
            start(controller) {
              controller.enqueue({
                type: "tool-call-delta",
                payload: { toolCallId: "call-1", toolName: "tool" },
              });
              controller.enqueue({
                type: "tool-result",
                payload: {
                  toolCallId: "call-1",
                  toolName: "tool",
                  result,
                },
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
      resource: "tool result",
      maximum: MAX_TOOL_RESULT_BYTES,
    });
    expect(streamCancelled).toBe(true);
  });

  it("rejects non-serializable tool results as malformed stream data", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const executor = createTestExecutor(['{"value":"done"}'], {
      chunks: [
        {
          type: "tool-call-delta",
          payload: { toolCallId: "call-1", toolName: "tool" },
        },
        {
          type: "tool-result",
          payload: {
            toolCallId: "call-1",
            toolName: "tool",
            result: circular,
          },
        },
      ],
    });

    await expect(executor.execute(request())).rejects.toBeInstanceOf(
      AcpMalformedStreamError,
    );
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
    const chunks = Array.from({ length: MAX_ACTIVITY_COUNT + 1 }, () => ({
      type: "tool-call-delta",
      payload: {
        toolCallId: "call-1",
        toolName: "tool",
      },
    }));
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

  it("serializes concurrent executions because ACP has one active prompt", async () => {
    let onPermissionRequest:
      NonNullable<AcpAgentFactoryOptions["onPermissionRequest"]> | undefined;
    let permissionRequested!: () => void;
    const permissionRequestedPromise = new Promise<void>((resolve) => {
      permissionRequested = resolve;
    });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;
    const executor = createAcpAdapter(configuration(), {
      createAgent: (options) => {
        onPermissionRequest = options.onPermissionRequest;
        return {
          stream: async (_messages, options) => {
            if (options.runId === "invocation-1") {
              await onPermissionRequest?.({});
              permissionRequested();
              await firstRelease;
            } else {
              secondStarted = true;
            }
            return stream('{"value":"done"}');
          },
        };
      },
    });

    const first = executor.execute(request());
    await permissionRequestedPromise;
    const second = executor.execute(request({ invocationId: "invocation-2" }));
    expect(secondStarted).toBe(false);
    releaseFirst();

    await expect(first).rejects.toMatchObject({
      name: "InteractionRequiredError",
    });
    await expect(second).resolves.toEqual({ value: "done" });
    expect(secondStarted).toBe(true);
  });

  it("does not start a queued execution after cancellation", async () => {
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;
    const executor = createAcpAdapter(configuration(), {
      createAgent: () => ({
        stream: async (_messages, options) => {
          if (options.runId === "invocation-1") {
            firstStarted();
            await firstRelease;
          } else {
            secondStarted = true;
          }
          return stream('{"value":"done"}');
        },
      }),
    });
    const first = executor.execute(request());
    await firstStartedPromise;
    const controller = new AbortController();
    const recorder = spanRecorder();
    const second = executor.execute(
      request({
        invocationId: "invocation-2",
        signal: controller.signal,
        observability: recorder.observability,
      }),
    );
    expect(recorder.spans).toEqual([]);
    controller.abort(new Error("cancel queued execution"));
    releaseFirst();

    await expect(first).resolves.toEqual({ value: "done" });
    await expect(second).rejects.toMatchObject({
      name: "AcpAdapterError",
      code: "cancellation",
    });
    expect(secondStarted).toBe(false);
    expect(recorder.spans).toEqual([]);
  });

  it("tears down every stream setup failure before replacing the private agent", async () => {
    const disconnected: string[] = [];
    const agents: TestAgent[] = [
      {
        disconnect: () => disconnected.push("first"),
        stream: async () => {
          throw new Error("first setup failed");
        },
      },
      {
        disconnect: () => disconnected.push("second"),
        stream: async () => {
          throw new Error("second setup failed");
        },
      },
      {
        stream: async () => stream('{"value":"recovered"}'),
      },
    ];
    const executor = createAcpAdapter(configuration(), {
      createAgent: () => {
        const agent = agents.shift();
        if (agent === undefined) throw new Error("test agent exhausted");
        return agent;
      },
    });

    await expect(executor.execute(request())).rejects.toMatchObject({
      name: "AcpAdapterError",
      code: "execution",
    });
    expect(disconnected).toEqual(["first"]);

    await expect(
      executor.execute(request({ invocationId: "invocation-2" })),
    ).rejects.toMatchObject({
      name: "AcpAdapterError",
      code: "execution",
    });
    expect(disconnected).toEqual(["first", "second"]);

    await expect(
      executor.execute(request({ invocationId: "invocation-3" })),
    ).resolves.toEqual({ value: "recovered" });
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
