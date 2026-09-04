// @test-scope ./mastra-acp-executor.ts
import type {
  ModelSelection,
  TaskDefinition,
  TaskDefinitionRegistry,
} from "@seqlane/core";
import type { AcpAgentOptions } from "@mastra/acp";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StructuredOutputValidationError } from "./errors.js";
import {
  createMastraAcpExecutor,
  type MastraAcpExecutorOptions,
} from "./mastra-acp-executor.js";

const outputSchema = z.object({ value: z.string() });

function task(): TaskDefinition {
  return {
    id: "agent-task",
    input: { parse: (value) => value },
    output: outputSchema,
    goal: (input) => `Complete ${String(input)}`,
    instructions: ["Keep the change small"],
    references: ["AGENTS.md"],
  };
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

function request(
  overrides: Partial<
    Parameters<ReturnType<typeof createMastraAcpExecutor>["execute"]>[0]
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
  options: Partial<MastraAcpExecutorOptions> = {},
) {
  const tasks: TaskDefinitionRegistry = new Map([["agent-task", task()]]);
  return createMastraAcpExecutor(tasks, {
    createAgent: () => ({
      stream: async () => {
        const output = outputs.shift();
        if (output === undefined) throw new Error("fake ACP output exhausted");
        return stream(output);
      },
    }),
    ...options,
  });
}

describe("Mastra ACP OpenCode executor", () => {
  it("routes agent work through ACP with the selected model and repository prompt", async () => {
    let agentOptions: Record<string, unknown> | undefined;
    let prompt = "";
    const selection: ModelSelection = {
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      reasoning: "high",
    };
    const executor = createMastraAcpExecutor(
      new Map([["agent-task", task()]]),
      {
        workspace: "/repo",
        selection,
        createAgent: (options) => {
          agentOptions = options as unknown as Record<string, unknown>;
          return {
            stream: async (messages) => {
              if (!Array.isArray(messages)) {
                throw new Error("Expected ACP prompt messages");
              }
              const [message] = messages;
              if (
                typeof message !== "object" ||
                message === null ||
                !("content" in message)
              ) {
                throw new Error("Expected an ACP user message");
              }
              prompt = String(message.content);
              return stream('{"value":"done"}', [
                {
                  type: "tool-call-delta",
                  payload: { toolCallId: "call-1", toolName: "read_file" },
                },
                {
                  type: "tool-result",
                  payload: {
                    toolCallId: "call-1",
                    toolName: "read_file",
                    result: "ok",
                  },
                },
              ]);
            },
          };
        },
      },
    );
    const activities: unknown[] = [];
    const metrics: unknown[] = [];

    await expect(
      executor.execute(
        request({
          onActivity: (activity) => activities.push(activity),
          onMetrics: (metric) => metrics.push(metric),
        }),
      ),
    ).resolves.toEqual({ value: "done" });

    expect(agentOptions).toMatchObject({
      command: "opencode",
      args: ["acp"],
      cwd: "/repo",
      model: "anthropic/claude-sonnet-4-6",
      persistSession: true,
    });
    expect(prompt).toContain("Keep the change small");
    expect(prompt).toContain("AGENTS.md");
    expect(activities).toHaveLength(2);
    expect(metrics[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });
  });

  it("validates ACP text as structured output and repairs malformed responses", async () => {
    const executor = createTestExecutor(["not json", '{"value":"repaired"}'], {
      resolveStructuredOutput: async () => ({
        strategy: "prompt",
        retryCount: 1,
        reason: "explicit",
      }),
    });

    await expect(executor.execute(request())).resolves.toEqual({
      value: "repaired",
    });
  });

  it("reports the native structured-output capability gap and rejects malformed final input", async () => {
    const diagnostics: string[] = [];
    const executor = createTestExecutor(["not json"], {
      resolveStructuredOutput: async () => ({
        strategy: "native",
        retryCount: 0,
        reason: "explicit",
      }),
    });

    await expect(
      executor.execute(
        request({ onDiagnostic: (message) => diagnostics.push(message) }),
      ),
    ).rejects.toBeInstanceOf(StructuredOutputValidationError);
    expect(diagnostics[0]).toContain("native structured-output");
    await expect(
      executor.execute(request({ taskId: "missing-task" })),
    ).rejects.toThrow("No agent task definition found");
  });

  it("passes cancellation to the ACP stream", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const executor = createMastraAcpExecutor(
      new Map([["agent-task", task()]]),
      {
        createAgent: () => ({
          stream: async (_messages, options) => {
            const abortSignal = options.abortSignal;
            if (abortSignal === undefined) {
              throw new Error("Expected an ACP abort signal");
            }
            receivedSignal = abortSignal;
            const aborted = new Promise<never>((_resolve, reject) =>
              abortSignal.aborted
                ? reject(abortSignal.reason ?? new Error("aborted"))
                : abortSignal.addEventListener(
                    "abort",
                    () => reject(abortSignal.reason ?? new Error("aborted")),
                    { once: true },
                  ),
            );
            return {
              fullStream: new ReadableStream<unknown>({
                start(controller) {
                  if (abortSignal.aborted) {
                    controller.error(new Error("ACP cancelled"));
                  } else {
                    abortSignal.addEventListener(
                      "abort",
                      () => controller.error(new Error("ACP cancelled")),
                      { once: true },
                    );
                  }
                },
              }),
              text: aborted,
            };
          },
        }),
      },
    );
    const execution = executor.execute(request({ signal: controller.signal }));
    controller.abort(new Error("cancelled by caller"));

    await expect(execution).rejects.toThrow("ACP cancelled");
    expect(receivedSignal).toBe(controller.signal);
  });

  it("cancels ACP permission requests instead of selecting an option", async () => {
    let onPermissionRequest: AcpAgentOptions["onPermissionRequest"];
    createMastraAcpExecutor(new Map([["agent-task", task()]]), {
      createAgent: (options) => {
        onPermissionRequest = options.onPermissionRequest;
        return {
          stream: async () => stream('{"value":"done"}'),
        };
      },
    });

    if (onPermissionRequest === undefined) {
      throw new Error("Expected the ACP permission callback to be configured");
    }

    await expect(
      onPermissionRequest({
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", title: "Run command" },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      }),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });
});
